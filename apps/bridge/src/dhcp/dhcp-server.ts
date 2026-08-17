import { isIPv4 } from 'node:net';

import { getTelemetryMeter } from '@repo/telemetry';

import { isRoutableUnicastIpv4 } from '../bridge-network/ip-utils.js';
import { getErrorMessage } from '../common/error-utils.js';
import { logError, logWarning } from '../logger/logger.service.js';
import { type ReplyTarget, chooseNakTarget, chooseReplyTarget } from './broadcast-socket.js';
import {
  DHCPACK,
  DHCPDECLINE,
  DHCPDISCOVER,
  DHCPINFORM,
  DHCPNAK,
  DHCPOFFER,
  DHCPRELEASE,
  DHCPREQUEST,
  type DhcpOption,
  OPT_BOOTFILE,
  OPT_BROADCAST,
  OPT_CLIENT_ARCH,
  OPT_DNS_SERVERS,
  OPT_LEASE_TIME,
  OPT_PARAM_REQ_LIST,
  OPT_REBINDING_TIME,
  OPT_RENEWAL_TIME,
  OPT_REQUESTED_IP,
  OPT_ROUTER,
  OPT_SERVER_ID,
  OPT_SUBNET_MASK,
  OPT_TFTP_SERVER,
  OPT_USER_CLASS,
  OPT_VENDOR_CLASS,
  OPT_VENDOR_ENCAP,
  encodeIp,
  encodeIps,
  encodeUint32,
} from './dhcp-options.js';
import type { DhcpMode } from './dhcp.config.js';
import { parseClientHostname } from './hostname.js';
import { InMemoryLeaseStore } from './lease-store/in-memory-lease-store.js';
import type { LeaseRecord } from './lease-store/lease-record.js';
import type { LeaseStore } from './lease-store/lease-store.js';
import { type DhcpMessage, buildReply } from './protocol.js';
import { Subnet, type SubnetConfig, type SubnetLease } from './subnet.js';

const ZERO_IP = '0.0.0.0';
const PXE_VENDOR_PREFIX = 'PXEClient';

const SUBOPT_PXE_DISCOVERY = 6;
const PXE_DISCOVERY_CONTROL_NO_MENU = 8;
const PXE_TLV_END = 0xff;

// Module-scope: created once, not per-engine (the engine hot-swaps on every atom config change).
// OTel merges identical instruments, so a stable single handle matches DhcpServerService's gauges.
const dhcpMessages = getTelemetryMeter('brokkr-bridge').createCounter('brokkr.dhcp.messages', {
  description: 'DHCP messages handled and replies produced by the engine, by message type',
});

// DHCP message-type wire values -> low-cardinality metric label names.
const MESSAGE_TYPE_NAMES: ReadonlyMap<number, string> = new Map([
  [DHCPDISCOVER, 'discover'],
  [DHCPOFFER, 'offer'],
  [DHCPREQUEST, 'request'],
  [DHCPDECLINE, 'decline'],
  [DHCPACK, 'ack'],
  [DHCPNAK, 'nak'],
  [DHCPRELEASE, 'release'],
  [DHCPINFORM, 'inform'],
]);

// Kea shared-network model: subnets grouped on one physical interface; hintless
// broadcast DISCOVERs are allocated across the group.
export interface SharedNetwork {
  interfaceKey: string;
  subnets: Subnet[];
}

/** Ingress signal from AF_PACKET or null for dgram/unicast paths. */
export interface IngressInfo {
  ifindex: number;
  ifname: string;
}

export interface DhcpReply {
  reply: Buffer;
  target: ReplyTarget;
  yiaddr: string;
  /** True when this reply is a DHCPNAK — routing must use broadcast per RFC 2131 §4.3.1. */
  isNak?: boolean;
  // Subnet's own serving-interface IP (opt-54): L3 source for AF_PACKET frames and dgram
  // send-socket selection, so a multi-subnet host replies from the correct interface.
  sourceIp: string;
}

export interface DhcpEngineLogger {
  warn(message: string): void;
  error(message: string): void;
}

function defaultEngineLogger(): DhcpEngineLogger {
  return {
    warn: (message) => void logWarning(message, { jobId: '' }),
    error: (message) => void logError(message, { jobId: '' }),
  };
}

export class DhcpEngine {
  private readonly sharedNetworks: SharedNetwork[];
  /** Subnets not bound to an interface (matched by giaddr for relayed traffic). */
  private readonly relayedSubnets: Subnet[];
  private readonly allSubnets: Subnet[];

  private writesEnabled = true;

  private peerDnsIp: string | null = null;

  // Ephemeral: the free address found during the last groupAllocate call, consumed
  // once by onDiscover so selectAddress can skip a redundant nextFreePoolAddress scan.
  private lastGroupAllocFreeAddr: string | null = null;

  readonly mode: DhcpMode;

  private peerServerIds: ReadonlySet<string> = new Set();

  private constructor(
    mode: DhcpMode,
    sharedNetworks: SharedNetwork[],
    relayedSubnets: Subnet[],
    allSubnets: Subnet[],
    private readonly now: () => number = () => Date.now() / 1000,
    private readonly leaseStore: LeaseStore = new InMemoryLeaseStore(),
    private readonly logger: DhcpEngineLogger = defaultEngineLogger(),
  ) {
    this.mode = mode;
    this.sharedNetworks = sharedNetworks;
    this.relayedSubnets = relayedSubnets;
    this.allSubnets = allSubnets;
  }

  // `mode` is the engine-level fallback for subnets without a per-subnet mode.
  static fromSubnets(
    opts: {
      mode: DhcpMode;
      networks: { interfaceKey: string; subnets: SubnetConfig[] }[];
      relayed?: SubnetConfig[];
    },
    now: () => number = () => Date.now() / 1000,
    leaseStore: LeaseStore = new InMemoryLeaseStore(),
    logger: DhcpEngineLogger = defaultEngineLogger(),
  ): DhcpEngine {
    const subnetLogger = { warn: (m: string) => logger.warn(m) };
    const all: Subnet[] = [];

    const sharedNetworks: SharedNetwork[] = opts.networks.map((net) => {
      const subnets = net.subnets.map((sc) => {
        const s = new Subnet(sc, now, subnetLogger);
        all.push(s);
        return s;
      });
      return { interfaceKey: net.interfaceKey, subnets };
    });

    const relayed = (opts.relayed ?? []).map((sc) => {
      const s = new Subnet(sc, now, subnetLogger);
      all.push(s);
      return s;
    });

    return new DhcpEngine(opts.mode, sharedNetworks, relayed, all, now, leaseStore, logger);
  }

  leases(): SubnetLease[] {
    return this.allSubnets.flatMap((s) => s.leases());
  }

  /** Expose all subnets (for testing/inspection). */
  getSubnets(): readonly Subnet[] {
    return this.allSubnets;
  }

  setWritesEnabled(enabled: boolean): void {
    this.writesEnabled = enabled;
  }

  setPeerDnsIp(ip: string | null): void {
    this.peerDnsIp = ip;
  }

  getPeerDnsIp(): string | null {
    return this.peerDnsIp;
  }

  setPeerServerIds(ids: ReadonlySet<string>): void {
    this.peerServerIds = ids;
  }

  getPeerServerIds(): ReadonlySet<string> {
    return this.peerServerIds;
  }

  // Hot-swap rebuilds create fresh Subnets, which would drop in-RAM decline backoffs and let a
  // just-declined address be re-offered — re-home each blocked IP into every containing subnet.
  seedDeclinesFrom(previous: DhcpEngine): void {
    for (const oldSubnet of previous.allSubnets) {
      for (const [ip, until] of oldSubnet.blockedUntil) {
        // Every containing subnet, not first match: overlapping/same-CIDR subnets can share a
        // network, and over-blocking duplicates is harmless — none may offer the declined IP.
        for (const newSubnet of this.allSubnets) {
          if (!newSubnet.containsIp(ip)) continue;
          // Keep the furthest-future expiry: sibling subnets can hold divergent expiries for
          // the same IP, and a stale sibling must not shorten fresher protection.
          const existing = newSubnet.blockedUntil.get(ip);
          if (existing === undefined || until > existing) newSubnet.blockedUntil.set(ip, until);
        }
      }
    }
  }

  private isKnownPeerServerId(opt54: string): boolean {
    return this.peerServerIds.has(opt54);
  }

  resetLeaseState(): void {
    for (const subnet of this.allSubnets) {
      subnet.resetLeaseState();
    }
  }

  async hydrate(): Promise<boolean> {
    let succeeded = true;
    let live: LeaseRecord[];
    try {
      live = await this.leaseStore.loadAll();
    } catch (error) {
      const notBound = error instanceof Error && error.name === 'DhcpLeaseCacheNotBoundError';
      const cause = notBound
        ? 'lease cache not yet bound (startup ordering)'
        : `lease store error (${getErrorMessage(error)})`;
      this.logger.error(`DHCP lease hydrate failed (${cause}); will NOT answer until hydrate succeeds, retrying`);
      live = [];
      succeeded = false;
    }
    // resetLeaseIndexes (not resetLeaseState) preserves decline backoff.
    for (const subnet of this.allSubnets) {
      subnet.resetLeaseIndexes();
    }
    for (const record of live) {
      let adopted = false;
      for (const subnet of this.allSubnets) {
        if (subnet.adoptLease(record)) {
          adopted = true;
          break;
        }
      }
      if (!adopted) {
        this.logger.warn(`DHCP hydrate: dropping lease ${record.ip} (mac ${record.mac}): not in any subnet`);
      }
    }
    return succeeded;
  }

  async pruneLeases(): Promise<void> {
    if (!this.writesEnabled) return;
    await this.leaseStore.pruneExpired(this.now());
  }

  private subnetMode(subnet: Subnet): DhcpMode {
    return subnet.config.mode ?? this.mode;
  }

  // A client on a secondary interface selects us by that subnet's opt-54, so any of our
  // per-subnet server-ids (or the global primary) must match.
  private isOwnServerId(ip: string, primaryServerId: string): boolean {
    if (ip === primaryServerId) return true;
    return this.allSubnets.some((s) => s.config.serverId !== '' && s.config.serverId === ip);
  }

  // Advertise the subnet's own interface IP (global primary for relayed/empty subnets) so a
  // secondary-interface client consistently sees — and echoes back — the IP it actually reached.
  private effectiveServerId(subnet: Subnet, serverId: string): string {
    return subnet.config.serverId !== '' ? subnet.config.serverId : serverId;
  }

  // undefined allowlist = allow all; empty Set = deny all (fail-closed). PROXY-mode gate only.
  private proxyMacAllowed(subnet: Subnet, mac: string): boolean {
    const allowlist = subnet.config.proxyAllowedMacs;
    if (allowlist === undefined) return true;
    return allowlist.has(mac);
  }

  servesPxeBoot(): boolean {
    return this.allSubnets.some(
      (s) =>
        this.subnetMode(s) === 'PROXY' ||
        s.config.tftpServer !== '' ||
        s.config.bootfile !== '' ||
        s.config.bootfileByArch.size > 0,
    );
  }

  handle(request: DhcpMessage, serverId: string, onPxePort = false, ingress?: IngressInfo | null): DhcpReply | null {
    const messageTypeName = MESSAGE_TYPE_NAMES.get(request.messageType);
    if (messageTypeName !== undefined) dhcpMessages.add(1, { type: messageTypeName });
    if (onPxePort) {
      if (this.isPxeRequest(request) && (request.messageType === DHCPREQUEST || request.messageType === DHCPINFORM)) {
        const subnet = this.selectSubnet(request, ingress ?? null) ?? this.allSubnets[0];
        if (subnet === undefined) return null;
        // allowlist is PROXY-only: AUTHORITATIVE also binds :4011 for its own PXE replies and must not be filtered
        if (this.subnetMode(subnet) === 'PROXY' && !this.proxyMacAllowed(subnet, request.chaddr)) return null;
        return this.buildProxyReply(request, serverId, DHCPACK, subnet);
      }
      return null;
    }

    // Select the subnet first so PROXY-vs-AUTHORITATIVE dispatches on the SELECTED subnet's
    // mode (ingress resolves fresh DISCOVERs too); engine mode is only the no-subnet fallback.
    const selectedSubnet = this.selectSubnet(request, ingress ?? null);
    const effectiveMode = selectedSubnet !== null ? this.subnetMode(selectedSubnet) : this.mode;

    if (effectiveMode === 'PROXY') {
      return this.handleProxy(request, serverId, onPxePort, selectedSubnet);
    }
    switch (request.messageType) {
      case DHCPDISCOVER:
        return this.onDiscover(request, serverId, selectedSubnet);
      case DHCPREQUEST:
        return this.onRequest(request, serverId, ingress ?? null);
      case DHCPINFORM:
        return this.onInform(request, serverId, ingress ?? null);
      case DHCPDECLINE:
        this.onDecline(request, serverId);
        return null;
      case DHCPRELEASE:
        this.onRelease(request, serverId);
        return null;
      default:
        return null;
    }
  }

  // Kea shared-network selection order: giaddr (relay) → ciaddr (renew) → requested-IP →
  // ingress-interface group allocation; null when nothing matches (drop).
  selectSubnet(request: DhcpMessage, ingress: IngressInfo | null): Subnet | null {
    if (request.giaddr !== ZERO_IP) {
      return (
        this.allSubnets.find((subnet) => subnet.config.relayAgentIp === request.giaddr) ??
        this.findSubnetByIp(request.giaddr, (subnet) => subnet.config.relayAgentIp === undefined)
      );
    }

    if (request.ciaddr !== ZERO_IP) {
      return this.findSubnetByIp(request.ciaddr);
    }

    const opt50 = this.optionIp(request, OPT_REQUESTED_IP);
    if (opt50 !== null) {
      return this.findSubnetByIp(opt50);
    }

    return this.groupAllocate(request.chaddr, ingress);
  }

  private findSubnetByIp(ip: string, filter: (subnet: Subnet) => boolean = () => true): Subnet | null {
    for (const subnet of this.allSubnets) {
      if (filter(subnet) && subnet.containsIp(ip)) return subnet;
    }
    return null;
  }

  // Ambiguous broadcast DISCOVER: prefer the subnet already binding this MAC, else the
  // first in the ingress interface's group with a free address.
  private groupAllocate(mac: string, ingress: IngressInfo | null): Subnet | null {
    let candidates: Subnet[] | null = null;
    if (ingress !== null) {
      const net = this.sharedNetworks.find((n) => n.interfaceKey === ingress.ifname);
      if (net !== undefined) candidates = net.subnets;
    }

    if (candidates === null || candidates.length === 0) {
      candidates = this.sharedNetworks.flatMap((n) => n.subnets);
    }
    if (candidates.length === 0) return null;

    for (const subnet of candidates) {
      if (subnet.hasBindingForMac(mac)) {
        this.lastGroupAllocFreeAddr = null;
        return subnet;
      }
    }

    for (const subnet of candidates) {
      const freeAddr = subnet.nextFreePoolAddress();
      if (freeAddr !== null) {
        this.lastGroupAllocFreeAddr = freeAddr;
        return subnet;
      }
    }

    // All subnets exhausted — return the first (NAK/drop logic handles it).
    this.lastGroupAllocFreeAddr = null;
    return candidates[0] ?? null;
  }

  private handleProxy(
    request: DhcpMessage,
    serverId: string,
    onPxePort: boolean,
    selectedSubnet: Subnet | null,
  ): DhcpReply | null {
    if (!this.isPxeRequest(request)) {
      return null;
    }
    // Ingress-selected subnet supplies the right TFTP/bootfile in a multi-subnet zone.
    const subnet = selectedSubnet ?? this.allSubnets[0];
    if (subnet === undefined) return null;
    if (!this.proxyMacAllowed(subnet, request.chaddr)) return null;
    if (!onPxePort && request.messageType === DHCPDISCOVER) {
      return this.buildProxyReply(request, serverId, DHCPOFFER, subnet);
    }
    if (onPxePort && (request.messageType === DHCPREQUEST || request.messageType === DHCPINFORM)) {
      return this.buildProxyReply(request, serverId, DHCPACK, subnet);
    }
    return null;
  }

  private buildProxyReply(request: DhcpMessage, serverId: string, messageType: number, subnet: Subnet): DhcpReply {
    // PXE next-step must be reachable from this subnet — its own server IP, not the global primary.
    const sid = this.effectiveServerId(subnet, serverId);
    const bootfile = this.bootfileFor(request, subnet);
    const siaddr = subnet.config.tftpServer || sid;
    const options: DhcpOption[] = [{ code: OPT_VENDOR_CLASS, value: Buffer.from(PXE_VENDOR_PREFIX, 'ascii') }];
    if (subnet.config.tftpServer !== '') {
      options.push({ code: OPT_TFTP_SERVER, value: Buffer.from(subnet.config.tftpServer, 'ascii') });
    }
    if (bootfile !== '') {
      // Some UEFI PXE ROMs (Dell iDRAC7) over-read an unterminated opt-67 value and mangle the
      // NBP filename ("ipxe-amd64.efi" -> "ipxe-amd64.efiij") -> PXE-E18. NUL-terminate it to match
      // the proven-good dnsmasq offer (len+1). ref beads local-sim-brpn.
      options.push({ code: OPT_BOOTFILE, value: Buffer.concat([Buffer.from(bootfile, 'ascii'), Buffer.from([0])]) });
      options.push({ code: OPT_VENDOR_ENCAP, value: pxeVendorEncap() });
    }

    const reply = buildReply(request, {
      messageType,
      yiaddr: ZERO_IP,
      serverId: sid,
      siaddr,
      bootfile: bootfile || undefined,
      options,
    });

    dhcpMessages.add(1, { type: messageType === DHCPACK ? 'ack' : 'offer' });
    const target: ReplyTarget = chooseReplyTarget(request);
    return { reply, target, yiaddr: ZERO_IP, sourceIp: sid };
  }

  private onDiscover(request: DhcpMessage, serverId: string, preSelected: Subnet | null): DhcpReply | null {
    const subnet = preSelected;
    if (subnet === null) return null;
    // Consume-and-clear the address groupAllocate stashed (see lastGroupAllocFreeAddr).
    const poolHint = this.lastGroupAllocFreeAddr;
    this.lastGroupAllocFreeAddr = null;
    const address = subnet.selectAddress(request.chaddr, this.requestedIpHint(request), poolHint);
    if (address === null) {
      return null;
    }
    const granted = this.commitLease(subnet, request, request.chaddr, address, parseClientHostname(request));
    return this.buildOfferOrAck(request, serverId, DHCPOFFER, address, granted, subnet);
  }

  private onRequest(request: DhcpMessage, serverId: string, ingress: IngressInfo | null): DhcpReply | null {
    const opt54 = this.optionIp(request, OPT_SERVER_ID);
    const opt50 = this.optionIp(request, OPT_REQUESTED_IP);

    if (opt50 !== null) {
      if (opt54 !== null) {
        return this.onSelecting(request, serverId, opt54, opt50, ingress);
      }
      return this.onInitReboot(request, serverId, opt50, ingress);
    }
    return this.onRenewing(request, serverId, ingress);
  }

  private onSelecting(
    request: DhcpMessage,
    serverId: string,
    opt54: string,
    opt50: string,
    ingress: IngressInfo | null,
  ): DhcpReply | null {
    if (!this.isOwnServerId(opt54, serverId) && !this.isKnownPeerServerId(opt54)) {
      return null;
    }
    const subnet = this.selectSubnet(request, ingress);
    if (subnet === null) {
      return this.nak(request, serverId);
    }
    const address = subnet.selectAddress(request.chaddr, opt50);
    if (address === null || address !== opt50 || subnet.heldByOther(opt50, request.chaddr)) {
      return this.nak(request, this.effectiveServerId(subnet, serverId));
    }
    const granted = this.commitLease(subnet, request, request.chaddr, address, parseClientHostname(request));
    return this.buildOfferOrAck(request, serverId, DHCPACK, address, granted, subnet);
  }

  private onInitReboot(
    request: DhcpMessage,
    serverId: string,
    opt50: string,
    ingress: IngressInfo | null,
  ): DhcpReply | null {
    const subnet = this.selectSubnet(request, ingress);
    if (subnet === null) {
      // Wrong subnet — NAK per RFC 2131 §4.3.2.
      return this.nak(request, serverId);
    }
    const sid = this.effectiveServerId(subnet, serverId);
    if (!subnet.manages(opt50, request.chaddr)) {
      return subnet.onSubnet(opt50) ? null : this.nak(request, sid);
    }
    if (!subnet.hasLease(request.chaddr) && !subnet.hasReservation(request.chaddr)) {
      return null;
    }
    if (subnet.heldByOther(opt50, request.chaddr)) {
      return this.nak(request, sid);
    }
    const owned = subnet.selectAddress(request.chaddr, opt50);
    if (owned === opt50) {
      const granted = this.commitLease(subnet, request, request.chaddr, opt50, parseClientHostname(request));
      return this.buildOfferOrAck(request, serverId, DHCPACK, opt50, granted, subnet);
    }
    return this.nak(request, sid);
  }

  private onRenewing(request: DhcpMessage, serverId: string, ingress: IngressInfo | null): DhcpReply | null {
    const ciaddr = request.ciaddr;
    if (ciaddr === ZERO_IP) {
      return this.nak(request, serverId);
    }

    const subnet = this.selectSubnet(request, ingress);
    if (subnet === null) {
      return this.nak(request, serverId);
    }
    const sid = this.effectiveServerId(subnet, serverId);

    if (!subnet.manages(ciaddr, request.chaddr)) {
      if (subnet.holdsActiveBinding(request.chaddr, ciaddr)) {
        if (subnet.isExcluded(ciaddr) || subnet.isBlocked(ciaddr)) return this.nak(request, sid);
        const renewed = this.commitLease(subnet, request, request.chaddr, ciaddr, parseClientHostname(request));
        return this.buildOfferOrAck(request, serverId, DHCPACK, ciaddr, renewed, subnet);
      }
      return subnet.onSubnet(ciaddr) ? null : this.nak(request, sid);
    }
    if (subnet.heldByOther(ciaddr, request.chaddr)) {
      return this.nak(request, sid);
    }
    if (subnet.isExcluded(ciaddr) || subnet.isBlocked(ciaddr)) {
      return this.nak(request, sid);
    }
    const granted = this.commitLease(subnet, request, request.chaddr, ciaddr, parseClientHostname(request));
    return this.buildOfferOrAck(request, serverId, DHCPACK, ciaddr, granted, subnet);
  }

  private onInform(request: DhcpMessage, serverId: string, ingress: IngressInfo | null): DhcpReply | null {
    const subnet = this.selectSubnet(request, ingress) ?? this.allSubnets[0];
    if (subnet === undefined) return null;

    const sid = this.effectiveServerId(subnet, serverId);
    const operator = this.operatorOptions(request, subnet);
    const operatorCodes = new Set(operator.map((tlv) => tlv.code));
    const base = [...this.commonOptions({ serverId: sid, subnet }), ...this.bootFields(request, subnet).options].filter(
      (tlv) => !operatorCodes.has(tlv.code),
    );
    const ciaddr = request.ciaddr !== ZERO_IP ? request.ciaddr : undefined;
    const reply = buildReply(request, {
      messageType: DHCPACK,
      yiaddr: ZERO_IP,
      ciaddr,
      serverId: sid,
      options: [...base, ...operator],
    });
    dhcpMessages.add(1, { type: 'ack' });
    return { reply, target: chooseReplyTarget(request), yiaddr: ZERO_IP, sourceIp: sid };
  }

  private onDecline(request: DhcpMessage, serverId: string): void {
    const opt54 = this.optionIp(request, OPT_SERVER_ID);
    // Accept any of our server-ids: a secondary-subnet client declines with that subnet's
    // opt-54, and gating on the global id alone would never block the address.
    if (opt54 !== null && !this.isOwnServerId(opt54, serverId)) return;
    const declined = this.optionIp(request, OPT_REQUESTED_IP);

    const subnet = this.findSubnetForMac(request.chaddr) ?? (declined !== null ? this.findSubnetByIp(declined) : null);
    if (subnet === null) return;

    const lease = subnet.leaseFor(request.chaddr);
    const target = declined ?? lease?.ip ?? null;
    this.forget(subnet, request.chaddr, declined);
    if (target !== null) {
      subnet.block(target);
      this.logger.warn(`DHCP DECLINE from ${request.chaddr} for ${target}: address marked not available`);
    }
  }

  private onRelease(request: DhcpMessage, serverId: string): void {
    // RELEASE MUST carry opt-54; accept any of our server-ids so a secondary-subnet
    // client's release still clears its lease instead of being ignored.
    const opt54 = this.optionIp(request, OPT_SERVER_ID);
    if (opt54 === null || !this.isOwnServerId(opt54, serverId)) return;

    const subnet = this.findSubnetForMac(request.chaddr);
    if (subnet === null) return;

    const lease = subnet.leaseFor(request.chaddr);
    if (!lease) return;
    if (request.ciaddr !== ZERO_IP && lease.ip !== request.ciaddr) {
      return;
    }
    // RFC 2131 §4.3.4: retain the binding for address-stability on re-DISCOVER.
    subnet.commitLease(lease.mac, lease.ip, 0);
    this.writeThrough(() => this.leaseStore.put({ ip: lease.ip, mac: lease.mac, hostname: null, expiresAt: 0 }));
  }

  private buildOfferOrAck(
    request: DhcpMessage,
    serverId: string,
    messageType: number,
    address: string,
    granted: number,
    subnet: Subnet,
  ): DhcpReply {
    const effectiveServerId = this.effectiveServerId(subnet, serverId);
    const pxe = this.pxeFields(request, subnet);
    const boot = this.bootFields(request, subnet);
    const base = [
      ...this.commonOptions({ serverId: effectiveServerId, leaseTime: granted, broadcastFrom: address, subnet }),
      ...pxe.options,
      ...boot.options,
    ];
    const operator = this.operatorOptions(request, subnet);
    const operatorCodes = new Set(operator.map((tlv) => tlv.code));
    const filtered = base.filter((tlv) => !operatorCodes.has(tlv.code));
    const ciaddr = messageType === DHCPACK && request.ciaddr !== ZERO_IP ? request.ciaddr : undefined;
    const reply = buildReply(request, {
      messageType,
      yiaddr: address,
      ciaddr,
      siaddr: boot.siaddr ?? pxe.siaddr ?? effectiveServerId,
      bootfile: boot.fileField ?? pxe.bootfile,
      serverName: boot.snameField,
      serverId: effectiveServerId,
      options: [...filtered, ...operator],
    });
    dhcpMessages.add(1, { type: messageType === DHCPACK ? 'ack' : 'offer' });
    return { reply, target: chooseReplyTarget(request), yiaddr: address, sourceIp: effectiveServerId };
  }

  private operatorOptions(request: DhcpMessage, subnet: Subnet): DhcpOption[] {
    if (subnet.config.dhcpOptions.length === 0) {
      return [];
    }
    const prl = request.options.get(OPT_PARAM_REQ_LIST);
    return subnet.config.dhcpOptions
      .filter((spec) => spec.force || prl === undefined || prl.includes(spec.code))
      .map((spec) => ({ code: spec.code, value: spec.value }));
  }

  private bootFields(
    request: DhcpMessage,
    subnet: Subnet,
  ): {
    siaddr?: string;
    fileField?: string;
    snameField?: string;
    options: DhcpOption[];
  } {
    const { bootBootfile, bootServerName, bootServerAddress } = subnet.config;
    if (bootBootfile === '' && bootServerName === '' && bootServerAddress === '') {
      return { options: [] };
    }

    const prl = request.options.get(OPT_PARAM_REQ_LIST);
    const requests = (code: number): boolean => prl !== undefined && prl.includes(code);

    const options: DhcpOption[] = [];
    let fileField: string | undefined;
    let snameField: string | undefined;

    const suppressBootfile = isIpxeUserClass(request.options.get(OPT_USER_CLASS));
    if (bootBootfile !== '' && !suppressBootfile) {
      if (requests(OPT_BOOTFILE)) {
        // Some UEFI PXE ROMs (Dell iDRAC7) over-read an unterminated opt-67 value and mangle the
        // NBP filename -> PXE-E18. NUL-terminate it to match the proven-good dnsmasq offer (len+1).
        // ref beads local-sim-brpn.
        options.push({
          code: OPT_BOOTFILE,
          value: Buffer.concat([Buffer.from(bootBootfile, 'ascii'), Buffer.from([0])]),
        });
      } else {
        fileField = bootBootfile;
      }
    }
    if (bootServerName !== '') {
      if (requests(OPT_TFTP_SERVER)) {
        options.push({ code: OPT_TFTP_SERVER, value: Buffer.from(bootServerName, 'ascii') });
      } else {
        snameField = bootServerName;
      }
    }

    const siaddr = bootServerAddress !== '' ? bootServerAddress : undefined;
    return { siaddr, fileField, snameField, options };
  }

  private nak(request: DhcpMessage, serverId: string): DhcpReply {
    // A NAK carries no subnet-scoped options, so it needs no subnet and is always emittable.
    const reply = buildReply(request, {
      messageType: DHCPNAK,
      yiaddr: ZERO_IP,
      serverId,
      options: [],
      forceBroadcast: true,
    });
    dhcpMessages.add(1, { type: 'nak' });
    return { reply, target: chooseNakTarget(request), yiaddr: ZERO_IP, isNak: true, sourceIp: serverId };
  }

  private commonOptions(opts: {
    serverId: string;
    leaseTime?: number;
    broadcastFrom?: string;
    subnet?: Subnet;
  }): DhcpOption[] {
    const subnet = opts.subnet ?? this.allSubnets[0];
    if (subnet === undefined) return [];

    const options: DhcpOption[] = [{ code: OPT_SUBNET_MASK, value: encodeIp(subnet.subnetMask) }];
    if (opts.broadcastFrom !== undefined) {
      options.push({ code: OPT_BROADCAST, value: encodeIp(subnet.broadcastAddress(opts.broadcastFrom)) });
    }
    if (subnet.config.routers.length > 0) {
      options.push({ code: OPT_ROUTER, value: encodeIps(subnet.config.routers) });
    }
    const dnsServers = this.dnsResolvers(opts.serverId, subnet);
    if (dnsServers.length > 0) {
      options.push({ code: OPT_DNS_SERVERS, value: encodeIps(dnsServers) });
    }
    if (opts.leaseTime !== undefined) {
      const lease = opts.leaseTime;
      options.push({ code: OPT_LEASE_TIME, value: encodeUint32(lease) });
      // T1=25%, T2=50% of lease — matches our legacy Kea config, not Kea's 50%/87.5% default.
      options.push({ code: OPT_RENEWAL_TIME, value: encodeUint32(Math.floor(lease * 0.25)) });
      options.push({ code: OPT_REBINDING_TIME, value: encodeUint32(Math.floor(lease * 0.5)) });
    }
    return options;
  }

  private dnsResolvers(serverId: string, subnet: Subnet): string[] {
    if (subnet.config.dnsServers.length > 0) return subnet.config.dnsServers;
    if (!subnet.config.dnsSelf || serverId === ZERO_IP || !isIPv4(serverId)) return [];
    const peer = this.peerDnsIp;
    // The peer DNS IP is resolved globally and may sit on another subnet; an out-of-CIDR
    // resolver would be unreachable for this subnet's clients, so gate on containsIp.
    if (peer !== null && peer !== serverId && isRoutableUnicastIpv4(peer) && subnet.containsIp(peer)) {
      return [serverId, peer];
    }
    return [serverId];
  }

  private leaseTimes(
    request: DhcpMessage,
    mac: string,
    ip: string,
    subnet: Subnet,
  ): { wire: number; expiresAt: number } {
    const max = subnet.config.leaseTtlSeconds;
    const now = this.now();
    const opt = request.options.get(OPT_LEASE_TIME);
    if (opt && opt.length >= 4) {
      const wire = Math.min(Math.max(opt.readUInt32BE(0), 120), max);
      return { wire, expiresAt: Math.floor(now + wire) };
    }
    const prior = subnet.leaseFor(mac);
    if (prior !== undefined && prior.ip === ip && prior.expiresAt > now) {
      const remaining = Math.min(Math.floor(prior.expiresAt - now), max);
      return { wire: Math.max(1, remaining), expiresAt: prior.expiresAt };
    }
    return { wire: max, expiresAt: Math.floor(now + max) };
  }

  // Direct single-server TFTP boot (this authoritative path), NOT proxyDHCP. We hand a real NBP
  // via siaddr(next-server)+opt66+opt67 — a plain dnsmasq dhcp-boot offer. We deliberately do NOT
  // emit opt60 (OPT_VENDOR_CLASS 'PXEClient') or opt43 (OPT_VENDOR_ENCAP discovery-control): some
  // Dell UEFI firmware treats those as a PXE-boot-server-discovery invitation, completes DORA, then
  // abandons the handshake and never TFTPs (PXE-E21, proven on an R620 by A/B vs a plain dnsmasq
  // offer). proxyDHCP (buildProxyReply, :4011) still carries them — there the vendor handshake is
  // the whole point. See local-sim-9biw.
  private pxeFields(
    request: DhcpMessage,
    subnet: Subnet,
  ): { siaddr?: string; bootfile?: string; options: DhcpOption[] } {
    if (!this.isPxeRequest(request) || subnet.config.tftpServer === '') {
      return { options: [] };
    }
    const bootfile = this.bootfileFor(request, subnet);
    const options: DhcpOption[] = [{ code: OPT_TFTP_SERVER, value: Buffer.from(subnet.config.tftpServer, 'ascii') }];
    if (bootfile !== '') {
      // Some UEFI PXE ROMs (Dell iDRAC7) over-read an unterminated opt-67 value and mangle the
      // NBP filename ("ipxe-amd64.efi" -> "ipxe-amd64.efiij") -> PXE-E18. NUL-terminate it to match
      // the proven-good dnsmasq offer (len+1). ref beads local-sim-brpn.
      options.push({ code: OPT_BOOTFILE, value: Buffer.concat([Buffer.from(bootfile, 'ascii'), Buffer.from([0])]) });
    }
    return { siaddr: subnet.config.tftpServer, bootfile: bootfile || undefined, options };
  }

  private isPxeRequest(request: DhcpMessage): boolean {
    const vendor = request.options.get(OPT_VENDOR_CLASS);
    if (vendor && vendor.toString('ascii').startsWith(PXE_VENDOR_PREFIX)) {
      return true;
    }
    return request.options.has(OPT_CLIENT_ARCH);
  }

  private bootfileFor(request: DhcpMessage, subnet: Subnet): string {
    if (isIpxeUserClass(request.options.get(OPT_USER_CLASS))) {
      return '';
    }
    // Per-device reservation override (Device.ipxeBuildTarget) beats the subnet-level bootfile.
    const override = subnet.bootByMac.get(request.chaddr);
    const byArchMap = override?.bootfileByArch ?? subnet.config.bootfileByArch;
    const defaultBootfile = override?.bootfile ?? subnet.config.bootfile;
    const archOpt = request.options.get(OPT_CLIENT_ARCH);
    if (archOpt && archOpt.length >= 2) {
      const byArch = byArchMap.get(archOpt.readUInt16BE(0));
      if (byArch !== undefined) return byArch;
    }
    return defaultBootfile;
  }

  private writeThrough(op: () => Promise<void>): void {
    if (!this.writesEnabled) return;
    void op().catch((error) => {
      this.logger.warn(`DHCP lease persistence write failed: ${getErrorMessage(error)}`);
    });
  }

  private commitLease(subnet: Subnet, request: DhcpMessage, mac: string, ip: string, hostname?: string | null): number {
    const { wire, expiresAt } = this.leaseTimes(request, mac, ip, subnet);
    if (subnet.heldByOther(ip, mac)) return wire;
    // Evict stale lease in a different subnet so groupAllocate doesn't oscillate.
    const oldSubnet = this.findSubnetForMac(mac);
    if (oldSubnet !== null && oldSubnet !== subnet) {
      this.forget(oldSubnet, mac, null);
    }
    // Drop the reclaimed IP's store record too — hydrate() would otherwise re-insert it.
    const reclaimed = subnet.reclaimPriorIp(mac, ip);
    if (reclaimed !== null) {
      this.writeThrough(() =>
        this.leaseStore.delete({ ip: reclaimed.ip, mac, hostname: null, expiresAt: reclaimed.expiresAt }),
      );
    }
    subnet.commitLease(mac, ip, expiresAt);

    this.writeThrough(() => this.leaseStore.put({ ip, mac, hostname: hostname ?? null, expiresAt }));
    return wire;
  }

  private forget(subnet: Subnet, mac: string, declinedIp: string | null): void {
    const lease = subnet.forgetMac(mac, declinedIp);
    if (lease) {
      const ip = lease.ip;
      this.writeThrough(() => this.leaseStore.delete({ ip, mac, hostname: null, expiresAt: lease.expiresAt }));
    }
  }

  private findSubnetForMac(mac: string): Subnet | null {
    for (const subnet of this.allSubnets) {
      if (subnet.hasLease(mac)) return subnet;
    }
    return null;
  }

  private requestedIpHint(request: DhcpMessage): string | null {
    return this.optionIp(request, OPT_REQUESTED_IP);
  }

  private optionIp(request: DhcpMessage, code: number): string | null {
    const opt = request.options.get(code);
    if (opt && opt.length === 4) return decodeIpSafe(opt);
    return null;
  }
}

function decodeIpSafe(buf: Buffer): string {
  return `${buf[0]}.${buf[1]}.${buf[2]}.${buf[3]}`;
}

function isIpxeUserClass(opt: Buffer | undefined): boolean {
  if (opt === undefined || opt.length === 0) return false;
  return opt.toString('ascii').includes('iPXE');
}

function pxeVendorEncap(): Buffer {
  return Buffer.from([SUBOPT_PXE_DISCOVERY, 0x01, PXE_DISCOVERY_CONTROL_NO_MENU, PXE_TLV_END]);
}
