import { ipInCidr, type NetworkInterface } from '../bridge-network/bridge-ip-resolution.service.js';
import { getErrorMessage } from '../common/error-utils.js';

import type { DhcpAtomValue } from './dhcp-atom-value.schema.js';
import { defaultBootfileByArch, defaultBridgeBootfile, resolveIpxeTarget } from './dhcp-boot-defaults.js';
import {
  DEFAULT_DECLINE_BACKOFF_SECONDS,
  intToIp,
  ipToInt,
  parseDhcpOptionValue,
  type DhcpOptionSpec,
} from './dhcp.config.js';
import type { PoolRange, SubnetConfig } from './subnet.js';

// A single DHCP option's value payload is length-prefixed by one byte, so it cannot exceed 255
// bytes on the wire (RFC 2132); encodeOptions enforces this and throws past it.
const MAX_DHCP_OPTION_BYTES = 255;

export interface AtomMappingResult {
  networks: Array<{ interfaceKey: string; subnets: SubnetConfig[] }>;
  relayed: SubnetConfig[];
  /** Non-OFF atoms that failed to map (no in-CIDR interface, no relay). When non-zero the
   *  caller must NOT cache the mapping fingerprint so the next reconcile re-maps. */
  unmappedNonOffCount: number;
}

export interface AtomMapperLogger {
  warn(message: string): void;
}

export function mapAtomsToEngine(
  atoms: ReadonlyMap<string, DhcpAtomValue>,
  interfaces: readonly NetworkInterface[],
  logger: AtomMapperLogger,
  declineBackoffSeconds: number = DEFAULT_DECLINE_BACKOFF_SECONDS,
): AtomMappingResult {
  const networkMap = new Map<string, SubnetConfig[]>();
  const relayed: SubnetConfig[] = [];
  let unmappedNonOffCount = 0;

  for (const [prefixId, atom] of atoms) {
    if (atom.mode === 'OFF') continue;

    // PXE-04: only fires on config change (the manager fingerprints before mapping), so no spam.
    if (atom.mode === 'PROXY' && !atom.proxyPeerAuthoritative) {
      logger.warn(
        `PXE-04: DHCP atom ${prefixId} (${atom.subnet}) runs PROXY mode with no external authoritative ` +
          'DHCP server declared — PXE clients get boot options but no lease authority exists on this ' +
          "segment. Declare the external server on the prefix's DHCP settings in the hub UI, or " +
          'configure the prefix as AUTHORITATIVE.',
      );
    }

    // The in-CIDR local iface IP is this subnet's server-id/network anchor — the bridge's
    // global primary IP is only in-CIDR for the primary subnet and would fail pool validation.
    const matchingIface = interfaces.find((iface) => ipInCidr(atom.subnet, iface.ip));
    // Relayed subnets (no in-CIDR iface) get server-id '' so the Subnet anchors on its
    // pool start and pool validation skips the server-id checks.
    const subnetServerId = matchingIface?.ip ?? '';

    let subnetConfig: SubnetConfig;
    try {
      subnetConfig = atomToSubnetConfig(atom, subnetServerId, interfaces, logger, declineBackoffSeconds);
    } catch (error) {
      // Count the failure as unmapped so hot-swap leaves the fingerprint unadvanced and retries on the
      // next reconcile — a transient build error must not be treated as a completed mapping.
      unmappedNonOffCount++;
      logger.warn(`DHCP atom ${prefixId}: skipping — failed to build subnet config: ${getErrorMessage(error)}`);
      continue;
    }

    if (matchingIface !== undefined) {
      const existing = networkMap.get(matchingIface.name);
      if (existing !== undefined) {
        existing.push(subnetConfig);
      } else {
        networkMap.set(matchingIface.name, [subnetConfig]);
      }
    } else if (atom.relay !== null) {
      relayed.push(subnetConfig);
    } else {
      unmappedNonOffCount++;
      logger.warn(`DHCP atom ${prefixId}: skipping subnet ${atom.subnet} — no local interface in CIDR and no relay`);
    }
  }

  const networks = [...networkMap.entries()].map(([ifaceKey, subnets]) => ({
    interfaceKey: ifaceKey,
    subnets,
  }));

  return { networks, relayed, unmappedNonOffCount };
}

function atomToSubnetConfig(
  atom: DhcpAtomValue,
  serverId: string,
  allInterfaces: readonly NetworkInterface[],
  logger: AtomMapperLogger,
  declineBackoffSeconds: number = DEFAULT_DECLINE_BACKOFF_SECONDS,
): SubnetConfig {
  const subnetMask = cidrToSubnetMask(atom.subnet);

  // Without these exclusions the allocator could lease a client an address already in use
  // by the server, gateway, relay agent, or another bridge IP on this subnet.
  const relayAgentIp = atom.relay?.relayAgentIp;
  const inSubnetLocalIps = allInterfaces.filter((iface) => ipInCidr(atom.subnet, iface.ip)).map((iface) => iface.ip);
  const excludeIps = [
    ...new Set(
      [serverId, ...atom.routers, ...(relayAgentIp ? [relayAgentIp] : []), ...inSubnetLocalIps].filter(
        (ip) => ip !== '',
      ),
    ),
  ];

  const pools: PoolRange[] = atom.pools.map((p) => ({
    start: ipToInt(p.start),
    end: ipToInt(p.end),
  }));

  const firstPool = atom.pools[0];
  const rangeStart = firstPool !== undefined ? firstPool.start : '';
  const rangeEnd = firstPool !== undefined ? firstPool.end : '';

  // Encode dhcpOptions from grammar strings to byte buffers.
  const dhcpOptions: DhcpOptionSpec[] = [];
  for (const opt of atom.dhcpOptions) {
    try {
      const tokens = opt.value.split(',').map((t) => t.trim());
      const encoded = parseDhcpOptionValue(opt.code, tokens);
      // An expanding grammar (RFC1035_NAME, opt 119) can encode a <=255-char value to >255 bytes;
      // encodeOptions would throw at packet-build time and sink the whole reply, so drop it here.
      if (encoded.length > MAX_DHCP_OPTION_BYTES) {
        logger.warn(
          `DHCP option ${opt.code}: encoded ${encoded.length} bytes exceeds the ${MAX_DHCP_OPTION_BYTES}-byte option limit, skipping`,
        );
        continue;
      }
      dhcpOptions.push({ code: opt.code, value: encoded, force: false });
    } catch (error) {
      logger.warn(`DHCP option ${opt.code}: encoding failed, skipping: ${getErrorMessage(error)}`);
    }
  }

  // Null nextServer defaults to this bridge's serving IP — the hub schema and prefix UI promise
  // "leave empty to derive from the serving bridge". Relayed subnets ('') need an explicit one.
  const pxeIntended = atom.ipxeBuildTarget !== null || atom.nextServer !== null;
  const candidateNextServer = atom.nextServer ?? serverId; // serverId is '' for relayed subnets
  const hasPxe = pxeIntended && candidateNextServer !== '';
  const tftpServer = hasPxe ? candidateNextServer : '';
  const resolvedTarget = hasPxe ? resolveIpxeTarget(atom.ipxeBuildTarget) : undefined;
  const bootfile = hasPxe ? defaultBridgeBootfile(resolvedTarget) : '';
  const bootfileByArch = hasPxe ? defaultBootfileByArch(resolvedTarget) : new Map<number, string>();

  return {
    mode: atom.mode,
    relayAgentIp,
    subnetMask,
    cidr: atom.subnet,
    rangeStart,
    rangeEnd,
    pools: pools.length > 0 ? pools : undefined,
    reservations: atom.reservations.map((r) => {
      if (hasPxe && r.bootFilename !== undefined && r.bootFilename !== '') {
        return {
          mac: r.mac,
          ip: r.ip,
          bootfile: r.bootFilename,
          bootfileByArch: new Map<number, string>(),
        };
      }
      if (hasPxe && r.ipxeBuildTarget) {
        const target = resolveIpxeTarget(r.ipxeBuildTarget);
        return {
          mac: r.mac,
          ip: r.ip,
          bootfile: defaultBridgeBootfile(target),
          bootfileByArch: defaultBootfileByArch(target),
        };
      }
      return { mac: r.mac, ip: r.ip };
    }),
    excludeIps,
    routers: atom.routers,
    dnsServers: atom.dnsServers,
    leaseTtlSeconds: atom.leaseTtlSeconds,
    declineBackoffSeconds,
    tftpServer,
    bootfile,
    bootfileByArch,
    bootBootfile: '',
    bootServerName: '',
    bootServerAddress: '',
    dhcpOptions,
    dnsSelf: atom.dnsServers.length === 0,
    serverId,
    // Per-subnet PROXY MAC allowlist from the hub atom. Empty Set = deny-all (fail-closed);
    // populated Set = only listed MACs may PXE-boot via PROXY. Gates PROXY replies only.
    proxyAllowedMacs: new Set(atom.proxyAllowedMacs),
  };
}

/** Takes the POST-validation networks, NOT the raw atoms: a subnet dropped by pool
 *  validation must not leave its interface in the served/DNS-bind set. */
export function atomServedInterfaceIps(
  networks: AtomMappingResult['networks'],
): Array<{ interface: string; ip: string; cidr: string }> {
  const seen = new Set<string>();
  const result: Array<{ interface: string; ip: string; cidr: string }> = [];
  for (const net of networks) {
    for (const subnet of net.subnets) {
      const cidr = subnet.cidr;
      if (subnet.serverId === '' || cidr === undefined || cidr === '') continue;
      const key = `${subnet.serverId}|${cidr}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ interface: net.interfaceKey, ip: subnet.serverId, cidr });
    }
  }
  return result;
}

export function relayedSubnetCidrs(relayed: readonly SubnetConfig[]): string[] {
  return [...new Set(relayed.map((subnet) => subnet.cidr).filter((cidr): cidr is string => !!cidr))];
}

/** Extract the subnet mask from a CIDR string, e.g. "10.0.1.0/24" -> "255.255.255.0". */
export function cidrToSubnetMask(cidr: string): string {
  const slash = cidr.indexOf('/');
  if (slash === -1) return '255.255.255.0';
  const prefix = Number.parseInt(cidr.slice(slash + 1), 10);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return '255.255.255.0';
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return intToIp(mask);
}
