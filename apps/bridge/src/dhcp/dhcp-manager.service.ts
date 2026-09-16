import * as crypto from 'node:crypto';
import * as dgram from 'node:dgram';

import { getTelemetryMeter } from '@repo/telemetry';

import { BOOT_CODES } from '@repo/utils';
import { type NetworkInterface, selfInterfaces, selfPrimary } from '../bridge-network/self-network.js';
import { getErrorMessage } from '../common/error-utils.js';
import { getLeaderService } from '../leader-election/leader-election.service.js';
import { logDebug, logError, logInfo, logWarning } from '../logger/logger.service.js';
import type { BackgroundService } from '../startup/orchestrator.js';

import { DHCP_SERVER_PORT, LIMITED_BROADCAST, type ReplyTarget, sendReply } from './broadcast-socket.js';
import {
  type AtomMappingResult,
  atomServedInterfaceIps,
  mapAtomsToEngine,
  relayedSubnetCidrs,
} from './dhcp-atom-mapper.js';
import type { DhcpAtomValue, DhcpZoneOpsAtomValue } from './dhcp-atom-value.schema.js';
import { latchMacWarning } from './dhcp-boot-defaults.js';
import { DhcpParseError, PXE_PORT } from './dhcp-options.js';
import { validateDhcpPoolConsistency } from './dhcp-pool-validation.js';
import { DhcpEngine, type DhcpReply } from './dhcp-server.js';
import { type DhcpRuntimeConfig, intToIp } from './dhcp.config.js';
import { BROADCAST_MAC, FrameParseError, buildFrame, ipToBuffer, macToBuffer, parseFrame } from './l2/frame.js';
import { type NativeSocketResult, type PacketSocket, tryCreateNativeSocket } from './l2/packet-socket.js';
import { type ReplyTransport, chooseNakRoute, chooseReplyRoute } from './l2/reply-routing.js';
import type { LeaseStore } from './lease-store/lease-store.js';
import { type DhcpMessage, parsePacket } from './protocol.js';
import type { PxeDecision, PxeObserver } from './pxe-decision.js';
import { ReplySocketSet } from './reply-sockets.js';
import type { SubnetConfig } from './subnet.js';
const WILDCARD_ADDRESS = '0.0.0.0';
const ZERO_IP = '0.0.0.0';
const HYDRATE_RETRY_MS = 250;
// Dual-delivery (AF_PACKET + dgram) lands within microseconds; 500ms is huge margin yet far
// under RFC 2131's ~3-5s first client retransmit.
const DUP_WINDOW_MS = 500;
// Soft cap: prune expired entries on insert once exceeded. Unexpired entries are never evicted
// (that would break dedup) — the map self-bounds at the request rate over one DUP_WINDOW_MS.
const DEDUP_MAP_CAP = 256;
const DEFAULT_LEADER_TTL_SECONDS = 30;

interface DhcpLogger {
  info(message: string, context: { jobId: string }): void;
  warn(message: string, context: { jobId: string }): void;
  error(message: string, context: { jobId: string }): void;
}

export interface DhcpPrimaryInterface {
  name: string;
  ip: string;
}

export interface DhcpStandbyHealth {
  isLeader: boolean;
  hydrated: boolean;
  answering: boolean;
  pxePortBound: boolean;
  claimFailureCount: number;
  lastClaimError: string | null;
  hydrateStalledSince: number | null;
  primaryInterface: DhcpPrimaryInterface | null;
}

export interface DhcpServerDeps {
  config: DhcpRuntimeConfig;
  resolvePrimary?: typeof selfPrimary;
  resolveInterfaces?: () => NetworkInterface[];
  createSocket?: () => dgram.Socket;
  createReplySocket?: () => dgram.Socket;
  /** Inject a PacketSocket factory for testing. Return a NativeSocketResult
   *  discriminating addon-unavailable (permanent) from NIC-specific errors (transient). */
  createPacketSocket?: (ifname: string) => NativeSocketResult;
  isLeader?: () => boolean;
  claimLeadershipIfVacant?: () => Promise<boolean>;
  now?: () => number;
  leaderTtlSeconds?: number;
  logger?: DhcpLogger;
  leaseStore?: LeaseStore;
  resolvePeerDnsIp?: (jobId: string) => Promise<string | null>;
  resolvePeerServerIds?: (jobId: string) => Promise<Set<string>>;
  /** Read DHCP config atoms from Redis. Returns null when unavailable (fail-closed). */
  readAtoms?: (jobId: string) => Promise<ReadonlyMap<string, DhcpAtomValue> | null>;
  /** Read the zone-global runtime-tuning atom. Null = absent/unreadable (keep current tuning). */
  readZoneOps?: (jobId: string) => Promise<DhcpZoneOpsAtomValue | null>;
  /** Called when atom config changes, publishing the set of interface IPs whose
   *  NICs fall inside an atom-configured DHCP subnet (shared with DNS). */
  publishAtomServedIps?: (ips: Array<{ interface: string; ip: string; cidr: string }>, relayedCidrs?: string[]) => void;
  /** Releases composition-owned resources (the atom/lease Redis client) on stop. */
  onStop?: () => Promise<void>;
  recordPxeDecision?: (mac: string, decision: PxeDecision, atMs: number) => Promise<void>;
}

export class DhcpServerService implements BackgroundService {
  readonly name = 'dhcp_server';

  private config: DhcpRuntimeConfig;
  private readonly resolvePrimary: typeof selfPrimary;
  private readonly resolveInterfaces: () => NetworkInterface[];
  private readonly createSocket: () => dgram.Socket;
  private readonly createReplySocket: () => dgram.Socket;
  private readonly createPacketSocket: (ifname: string) => NativeSocketResult;
  private readonly isLeader: () => boolean;
  private readonly claimLeadershipIfVacant: () => Promise<boolean>;
  private readonly logger: DhcpLogger;
  private readonly now?: () => number;
  private readonly nowMs: () => number;
  private readonly leaderTtlSeconds: number;
  private readonly leaseStore?: LeaseStore;
  private readonly resolvePeerDnsIp: (jobId: string) => Promise<string | null>;
  private readonly resolvePeerServerIds: (jobId: string) => Promise<Set<string>>;
  private readonly readAtoms: ((jobId: string) => Promise<ReadonlyMap<string, DhcpAtomValue> | null>) | null;
  private readonly readZoneOps: ((jobId: string) => Promise<DhcpZoneOpsAtomValue | null>) | null;
  private readonly publishAtomServedIps:
    | ((ips: Array<{ interface: string; ip: string; cidr: string }>, relayedCidrs?: string[]) => void)
    | null;
  private readonly onStop: (() => Promise<void>) | null;

  private readonly engineRebuilds = getTelemetryMeter('brokkr-bridge').createCounter('brokkr.dhcp.engine_rebuilds', {
    description: 'DHCP engine build/hot-swap/teardown events, by reason',
  });
  private readonly proxyRefusals = getTelemetryMeter('brokkr-bridge').createCounter('brokkr.dhcp.proxy_refusals', {
    description: 'PXE requests refused by the proxy allowlist',
  });
  private readonly pxeObserver: PxeObserver;

  // Stable fingerprint of the last-applied atom config so reconcile only rebuilds on change.
  private lastAtomConfigFingerprint: string | null = null;
  // Rate-limit all-fail pool-validation warnings: single-entry since only the current
  // fingerprint matters. Warn at most once per 60s per fingerprint.
  private allFailWarnedAt: { fingerprint: string; warnedAt: number } | null = null;
  // Same rate-limit for the duplicate-relay-agent-IP guard, which also keeps the old engine.
  private relayDupWarnedAt: { fingerprint: string; warnedAt: number } | null = null;
  private static readonly ALL_FAIL_WARN_INTERVAL_MS = 60_000;

  private claimFailureCount = 0;
  private lastClaimError: string | null = null;
  private hydrateStalledSinceMs: number | null = null;
  private hydrateStallWarned = false;

  private engine: DhcpEngine | null = null;

  private serverId = '';
  private primaryInterface: DhcpPrimaryInterface | null = null;

  private socket: dgram.Socket | null = null;
  private pxeSocket: dgram.Socket | null = null;
  private replySockets: ReplySocketSet | null = null;

  // BPF receive + reply sockets open ONLY on these NICs (IP inside a live atom subnet) — never
  // e.g. the real-LAN uplink, or the bridge would answer DHCP off-network as a rogue server.
  private servedInterfaceNames = new Set<string>();

  // Keyed by interface name; empty when the AF_PACKET addon is unavailable (non-Linux).
  private readonly packetSockets = new Map<string, { socket: PacketSocket; ifindex: number }>();
  // Set to true once the AF_PACKET addon/capability is confirmed unavailable (host-wide), so the
  // reconcile stops re-probing and re-logging every pass (e.g. addon absent on macOS dev).
  private afpacketDisabled = false;
  // Request identity -> expiry (ms): dedups a broadcast delivered on both the AF_PACKET and
  // dgram paths (see processRequest).
  private readonly recentRequestExpiry = new Map<string, number>();

  private reconciling = false;
  private hydrated = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private hydrateRetryTimer: ReturnType<typeof setTimeout> | null = null;

  private released = false;
  private releaseFn: (() => void) | null = null;

  constructor(deps: DhcpServerDeps) {
    this.config = deps.config;
    this.resolvePrimary = deps.resolvePrimary ?? selfPrimary;
    // ALL host interfaces — the atom mapper's CIDR match is the real filter; a name heuristic
    // (e.g. excluding br-*) would false-positive on data-plane bridges like br-brokkr.
    this.resolveInterfaces = deps.resolveInterfaces ?? ((): NetworkInterface[] => selfInterfaces());
    this.createSocket =
      deps.createSocket ?? ((): dgram.Socket => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
    this.createReplySocket =
      deps.createReplySocket ?? ((): dgram.Socket => dgram.createSocket({ type: 'udp4', reuseAddr: true }));
    this.createPacketSocket =
      deps.createPacketSocket ?? ((ifname: string): NativeSocketResult => tryCreateNativeSocket(ifname));
    this.isLeader = deps.isLeader ?? ((): boolean => getLeaderService()?.isLeader ?? false);
    this.claimLeadershipIfVacant =
      deps.claimLeadershipIfVacant ??
      (async (): Promise<boolean> => (await getLeaderService()?.tryClaimLeadershipIfVacant()) ?? false);
    this.logger = deps.logger ?? defaultLogger();
    this.now = deps.now;
    this.nowMs = deps.now ?? ((): number => Date.now());
    this.leaderTtlSeconds = deps.leaderTtlSeconds ?? DEFAULT_LEADER_TTL_SECONDS;
    this.leaseStore = deps.leaseStore;
    this.resolvePeerDnsIp = deps.resolvePeerDnsIp ?? (async (): Promise<string | null> => null);
    this.resolvePeerServerIds = deps.resolvePeerServerIds ?? (async (): Promise<Set<string>> => new Set());
    this.readAtoms = deps.readAtoms ?? null;
    this.readZoneOps = deps.readZoneOps ?? null;
    this.publishAtomServedIps = deps.publishAtomServedIps ?? null;
    this.onStop = deps.onStop ?? null;

    const refusalWarned = new Set<string>();
    const record = deps.recordPxeDecision;
    this.pxeObserver = {
      onDecision: (mac, decision) => {
        if (decision === 'refused-allowlist') {
          this.proxyRefusals.add(1);
          if (latchMacWarning(refusalWarned, mac)) {
            const spec = BOOT_CODES['PXE-110'];
            const message = `${spec.code} ${spec.title}: ${mac} is not in the proxy allowlist. ${spec.remedy}`;
            if (spec.severity === 'error') this.logger.error(message, { jobId: '' });
            else this.logger.warn(message, { jobId: '' });
          }
        }
        if (record !== undefined) {
          void record(mac, decision, Date.now()).catch((error) => {
            void logDebug(`DHCP PXE decision write for ${mac} failed: ${getErrorMessage(error)}`);
          });
        }
      },
    };

    // Registered once here (not on the engine): callbacks read `this.engine` at
    // collection time, so a hot-swap never strands them on a stale reference.
    const meter = getTelemetryMeter('brokkr-bridge');
    meter
      .createObservableGauge('brokkr.dhcp.leases_active', {
        description: 'Active (non-expired) in-RAM DHCP leases, by subnet',
      })
      .addCallback((result) => {
        for (const subnet of this.engine?.getSubnets() ?? []) {
          result.observe(subnet.activeLeaseCount(), { subnet: subnet.cidr });
        }
      });
    meter
      .createObservableGauge('brokkr.dhcp.pool_size', {
        description: 'Total allocatable DHCP addresses, by subnet',
      })
      .addCallback((result) => {
        for (const subnet of this.engine?.getSubnets() ?? []) {
          result.observe(subnet.poolSize, { subnet: subnet.cidr });
        }
      });
  }

  getServerId(): string {
    return this.serverId;
  }

  // NIC-granular, so a served NIC's other addresses are bound too; harmless because a reply socket
  // registers no 'message' handler and socketFor only ever picks one whose CIDR holds the target.
  private servedInterfaces(): NetworkInterface[] {
    if (this.servedInterfaceNames.size === 0) return [];
    return this.resolveInterfaces().filter((iface) => this.servedInterfaceNames.has(iface.name));
  }

  // Falls back to the FULL interface set before the first atom maps, so a data-plane-bridge-only
  // host (e.g. br-brokkr) still gets a serverId.
  private refreshServerId(jobId: string): void {
    const served = this.servedInterfaces();
    const candidates = served.length > 0 ? served : this.resolveInterfaces();
    const resolve = (): NetworkInterface[] => candidates;
    // client-facing first so a lo alias inside a served subnet never becomes the server-id; the
    // unfiltered fallback keeps a br-brokkr-only host deriving one (see resolveInterfaces).
    const primary = this.resolvePrimary({ clientFacingOnly: true }, resolve) ?? this.resolvePrimary({}, resolve);
    if (primary === null) {
      if (this.serverId === '') {
        this.logger.warn('DHCP server: no interface IPv4 to derive a server-id', { jobId });
      }
      return;
    }
    const chosen = candidates.find((iface) => iface.ip === primary.ip);
    this.primaryInterface = { name: chosen?.name ?? '', ip: primary.ip };
    if (primary.ip !== this.serverId) {
      const previous = this.serverId;
      this.serverId = primary.ip;
      if (previous === '') {
        this.logger.info(`DHCP server-id resolved from primary interface: ${this.serverId}`, { jobId });
      } else {
        this.logger.info(`DHCP server-id refreshed: ${previous} -> ${this.serverId}`, { jobId });
      }
    }
  }

  async start(jobId: string): Promise<void> {
    // Per-subnet serverIds are authoritative for opt-54/L2 source; this manager serverId is
    // only a fallback for engine.handle and dgram lookups.
    this.refreshServerId(jobId);

    this.replySockets = new ReplySocketSet(this.createReplySocket, () => this.servedInterfaces(), {
      info: (message) => this.logger.info(message, { jobId }),
      warn: (message) => this.logger.warn(message, { jobId }),
    });

    this.logger.info('DHCP server starting (atoms-only, hot-standby reconcile loop)', { jobId });

    await this.reconcile(jobId);
    if (this.released) return;
    this.pollTimer = setInterval(() => void this.reconcile(jobId), this.config.leaderPollMs);
    this.pollTimer.unref?.();
    this.pruneTimer = setInterval(() => this.pruneLeases(jobId), this.config.pruneIntervalMs);
    this.pruneTimer.unref?.();

    await new Promise<void>((resolve) => {
      if (this.released) {
        resolve();
        return;
      }
      this.releaseFn = resolve;
    });
  }

  async stop(jobId: string): Promise<void> {
    // set before the onStop await so an in-flight reconcile can't resume against a closing client.
    this.released = true;
    this.engine?.setWritesEnabled(false);
    this.hydrated = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.hydrateRetryTimer !== null) {
      clearTimeout(this.hydrateRetryTimer);
      this.hydrateRetryTimer = null;
    }
    this.unbindPort(DHCP_SERVER_PORT, jobId);
    this.unbindPort(PXE_PORT, jobId);
    this.replySockets?.closeAll();
    this.closePacketSockets();

    if (this.onStop !== null) {
      try {
        await this.onStop();
      } catch (error) {
        this.logger.warn(`DHCP server stop hook failed: ${getErrorMessage(error)}`, { jobId });
      }
    }

    if (this.releaseFn !== null) {
      const release = this.releaseFn;
      this.releaseFn = null;
      release();
    }

    this.logger.info('DHCP server stopped', { jobId });
  }

  private async reconcile(jobId: string): Promise<void> {
    if (this.reconciling || this.released) {
      void logDebug(`DHCP reconcile skipped: ${this.reconciling ? 'reconciling' : 'released'}`, { jobId });
      return;
    }
    this.reconciling = true;
    try {
      // Refresh before atom mapping — a host that started with no interfaces
      // (serverId === '') would otherwise stay dormant forever.
      this.refreshServerId(jobId);

      await this.refreshRuntimeConfig(jobId);

      if (this.readAtoms !== null) {
        await this.applyAtomConfig(jobId);
        // Again after mapping: the pre-map call above can only see the global primary, so a fresh
        // served set would otherwise leave the fallback serverId one poll stale.
        this.refreshServerId(jobId);
      } else {
        void logDebug('DHCP reconcile atom step skipped: no reader', { jobId });
      }

      const engine = this.engine;

      if (engine !== null) {
        const hasProxy = engine.mode === 'PROXY' || engine.servesPxeBoot();

        // PROXY binds :4011 first (its hot-standby ordering).
        if (engine.mode === 'PROXY' && this.pxeSocket === null) {
          await this.bindPort(PXE_PORT, jobId);
        }
        const pxeReady = engine.mode !== 'PROXY' || this.pxeSocket !== null;
        if (this.socket === null && pxeReady) {
          await this.bindPort(DHCP_SERVER_PORT, jobId);
        }
        if (engine.mode === 'PROXY' && this.socket === null && this.pxeSocket !== null) {
          this.unbindPort(PXE_PORT, jobId);
        }
        // Non-PROXY binds :4011 only while :67 is up — a failed :67 bind must never leave an orphan PXE socket.
        if (engine.mode !== 'PROXY' && this.socket !== null && hasProxy && this.pxeSocket === null) {
          await this.bindPort(PXE_PORT, jobId);
        }
        if (engine.mode !== 'PROXY' && this.socket === null && this.pxeSocket !== null) {
          this.unbindPort(PXE_PORT, jobId);
        }
        if (engine.mode !== 'PROXY' && !hasProxy && this.pxeSocket !== null) {
          this.unbindPort(PXE_PORT, jobId);
        }
      }

      if (!this.isLeader()) {
        try {
          await this.claimLeadershipIfVacant();
        } catch (error) {
          this.claimFailureCount += 1;
          this.lastClaimError = getErrorMessage(error);
          this.logger.warn(`DHCP opportunistic leadership claim failed: ${this.lastClaimError}`, { jobId });
        }
      }

      const leader = this.isLeader();
      if (leader) this.lastClaimError = null;
      if (leader && !this.hydrated && engine !== null) {
        if (!(await engine.hydrate())) {
          this.noteHydrateStall(jobId);
          this.scheduleHydrateRetry(jobId);
          return;
        }
        this.hydrated = true;
        this.hydrateStalledSinceMs = null;
        this.hydrateStallWarned = false;
        engine.setWritesEnabled(true);
      } else if (!leader && this.hydrated && engine !== null) {
        this.hydrated = false;
        this.hydrateStalledSinceMs = null;
        this.hydrateStallWarned = false;
        engine.setWritesEnabled(false);
        engine.resetLeaseState();
        this.logger.info('DHCP server lost leadership; now dropping packets (socket stays bound)', { jobId });
      } else if (!leader) {
        this.hydrateStalledSinceMs = null;
        this.hydrateStallWarned = false;
      }

      if (this.replySockets !== null) {
        await this.replySockets.refresh();
      }

      this.reconcileAfpacketSockets(jobId);

      if (engine !== null) {
        await this.refreshPeerDnsIp(engine, jobId);
        await this.refreshPeerServerIds(engine, jobId);
      }

      // Last in the pass: revocation is not latency-critical, and awaiting it earlier
      // delays socket reconciliation by a tick.
      if (leader && this.hydrated && engine !== null) {
        await this.drainLeaseRevocations(engine, jobId);
      }
    } catch (error) {
      this.logger.warn(`DHCP reconcile failed: ${getErrorMessage(error)}`, { jobId });
    } finally {
      this.reconciling = false;
    }
  }

  /** Apply operator lease revocations the hub queued in Redis.
   * Leader-only: it holds the lease in memory, and draining on a follower would lose the marker. */
  private async drainLeaseRevocations(engine: DhcpEngine, jobId: string): Promise<void> {
    if (this.leaseStore === undefined) return;
    let ips: string[];
    try {
      ips = await this.leaseStore.takeRevocations();
    } catch (error) {
      this.logger.warn(`DHCP revocation drain failed: ${getErrorMessage(error)}`, { jobId });
      return;
    }
    for (const ip of ips) {
      const dropped = engine.revokeLease(ip);
      this.logger.info(
        dropped
          ? `DHCP lease ${ip} revoked by operator request`
          : `DHCP lease ${ip} revocation requested but no lease was held`,
        { jobId },
      );
    }
  }

  private pruneLeases(jobId: string): void {
    const engine = this.engine;
    if (engine === null || !this.isLeader() || !this.hydrated) return;
    void engine.pruneLeases().catch((error) => {
      this.logger.warn(`DHCP lease prune failed: ${getErrorMessage(error)}`, { jobId });
    });
  }

  // Absent/unreadable atom keeps the current tuning; interval changes re-arm the live timers.
  private async refreshRuntimeConfig(jobId: string): Promise<void> {
    if (this.readZoneOps === null) return;
    const next = await this.readZoneOps(jobId);
    if (next === null) return;

    const pollChanged = next.leaderPollMs !== this.config.leaderPollMs;
    const pruneChanged = next.pruneIntervalMs !== this.config.pruneIntervalMs;
    const declineChanged = next.declineBackoffSeconds !== this.config.declineBackoffSeconds;
    if (!pollChanged && !pruneChanged && !declineChanged) return;

    this.logger.info(
      `DHCP runtime tuning changed via zone atom (leaderPollMs=${next.leaderPollMs}, ` +
        `pruneIntervalMs=${next.pruneIntervalMs}, declineBackoffSeconds=${next.declineBackoffSeconds})`,
      { jobId },
    );
    this.config = {
      leaderPollMs: next.leaderPollMs,
      pruneIntervalMs: next.pruneIntervalMs,
      declineBackoffSeconds: next.declineBackoffSeconds,
    };

    // The backoff reaches the engine only through mapAtomsToEngine, which applyAtomConfig gates
    // on the atom fingerprint — invalidate it so this reconcile pass rebuilds with the new value.
    if (declineChanged) {
      this.lastAtomConfigFingerprint = null;
    }

    if (pollChanged && this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => void this.reconcile(jobId), this.config.leaderPollMs);
      this.pollTimer.unref?.();
    }
    if (pruneChanged && this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = setInterval(() => this.pruneLeases(jobId), this.config.pruneIntervalMs);
      this.pruneTimer.unref?.();
    }
  }

  private async refreshPeerDnsIp(engine: DhcpEngine, jobId: string): Promise<void> {
    try {
      engine.setPeerDnsIp(await this.resolvePeerDnsIp(jobId));
    } catch (error) {
      this.logger.warn(`DHCP peer-DNS-IP refresh failed: ${getErrorMessage(error)}`, { jobId });
    }
  }

  private async refreshPeerServerIds(engine: DhcpEngine, jobId: string): Promise<void> {
    try {
      engine.setPeerServerIds(await this.resolvePeerServerIds(jobId));
    } catch (error) {
      this.logger.warn(`DHCP peer-server-id refresh failed: ${getErrorMessage(error)}`, { jobId });
    }
  }

  private async applyAtomConfig(jobId: string): Promise<void> {
    if (this.readAtoms === null) return;

    const atoms = await this.readAtoms(jobId);
    // Fail-closed: reader error -> keep current engine.
    if (atoms === null) {
      void logDebug('DHCP reconcile atom step skipped: reader error', { jobId });
      return;
    }

    // No atoms -> tear down: live OFF transition. Fingerprint uses atoms-only
    // (no interfaces to resolve) so a NIC change while empty is a no-op.
    if (atoms.size === 0) {
      const fingerprint = atomConfigFingerprint(atoms, []);
      if (fingerprint === this.lastAtomConfigFingerprint) {
        void logDebug('DHCP reconcile atom step skipped: unchanged fingerprint', { jobId });
        return;
      }
      this.servedInterfaceNames.clear();
      this.publishAtomServedIps?.([]);
      this.tearDownEngine(jobId);
      this.lastAtomConfigFingerprint = fingerprint;
      return;
    }

    // Resolve interfaces BEFORE the fingerprint so a live NIC change triggers a remap +
    // rebuild + republish even without an atom edit.
    const interfaces = this.resolveInterfaces();

    const fingerprint = atomConfigFingerprint(atoms, interfaces);
    if (fingerprint === this.lastAtomConfigFingerprint) {
      void logDebug('DHCP reconcile atom step skipped: unchanged fingerprint', { jobId });
      return;
    }

    let mapping: AtomMappingResult;
    try {
      mapping = mapAtomsToEngine(
        atoms,
        interfaces,
        { warn: (message) => this.logger.warn(message, { jobId }) },
        this.config.declineBackoffSeconds,
      );
    } catch (error) {
      this.logger.warn(`DHCP atom mapping failed, keeping current engine: ${getErrorMessage(error)}`, { jobId });
      return;
    }

    // No subnets derived from atoms (all skipped/OFF) -> tear down.
    if (mapping.networks.length === 0 && mapping.relayed.length === 0) {
      this.servedInterfaceNames.clear();
      this.publishAtomServedIps?.([]);
      this.tearDownEngine(jobId);
      // Advance the fingerprint only when every atom is genuinely OFF. A non-OFF atom that
      // mapped to nothing means its interface isn't up YET — leave it so the next tick re-maps.
      if ([...atoms.values()].every((a) => a.mode === 'OFF')) {
        this.lastAtomConfigFingerprint = fingerprint;
      }
      return;
    }

    // Validate PER subnet and DROP a bad one (warn) — a single malformed atom must not block
    // the hot-swap for every other healthy prefix.
    const poolOk = (sc: SubnetConfig): boolean => {
      // Validate EVERY pool, not just pools[0]: a malformed LATER pool must not slip into the
      // engine. Fall back to the string rangeStart/rangeEnd when pools[] is absent.
      const ranges: Array<{ rangeStart: string; rangeEnd: string }> =
        sc.pools && sc.pools.length > 0
          ? sc.pools.map((p) => ({ rangeStart: intToIp(p.start), rangeEnd: intToIp(p.end) }))
          : [{ rangeStart: sc.rangeStart, rangeEnd: sc.rangeEnd }];
      // PROXY subnets never serve addresses, so an empty pool is valid; AUTHORITATIVE ones must
      // still pass validateDhcpPoolConsistency (no pool AND no reservations = nothing to serve).
      const allEmpty = ranges.every((r) => r.rangeStart === '' || r.rangeEnd === '');
      if (allEmpty && sc.mode === 'PROXY') return true;
      if (allEmpty && sc.mode !== 'PROXY') {
        try {
          validateDhcpPoolConsistency({
            rangeStart: '',
            rangeEnd: '',
            subnetMask: sc.subnetMask,
            serverId: sc.serverId,
            reservations: sc.reservations,
            routers: sc.routers,
          });
          return true;
        } catch (error) {
          this.logger.warn(
            `DHCP subnet ${sc.serverId}/${sc.subnetMask} dropped from hot-swap: ${getErrorMessage(error)}`,
            { jobId },
          );
          return false;
        }
      }
      try {
        for (const { rangeStart, rangeEnd } of ranges) {
          validateDhcpPoolConsistency({
            rangeStart,
            rangeEnd,
            subnetMask: sc.subnetMask,
            serverId: sc.serverId,
            reservations: sc.reservations,
            routers: sc.routers,
          });
        }
        return true;
      } catch (error) {
        this.logger.warn(
          `DHCP subnet (pools ${ranges.map((r) => `${r.rangeStart}-${r.rangeEnd}`).join(', ')}) dropped from hot-swap: ${getErrorMessage(error)}`,
          { jobId },
        );
        return false;
      }
    };
    const networks = mapping.networks
      .map((net) => ({ ...net, subnets: net.subnets.filter(poolOk) }))
      .filter((net) => net.subnets.length > 0);
    const relayed = mapping.relayed.filter(poolOk);
    const relayAgentIps = new Set<string>();
    for (const subnet of [...networks.flatMap((network) => network.subnets), ...relayed]) {
      const relayAgentIp = subnet.relayAgentIp;
      if (relayAgentIp === undefined) continue;
      if (relayAgentIps.has(relayAgentIp)) {
        // Fingerprint stays unset so a corrected atom is retried next tick; latch the warning
        // like allFailWarnedAt or an unchanged bad config logs every poll tick.
        const nowMs = this.nowMs();
        const prev = this.relayDupWarnedAt;
        if (
          prev === null ||
          prev.fingerprint !== fingerprint ||
          nowMs - prev.warnedAt >= DhcpServerService.ALL_FAIL_WARN_INTERVAL_MS
        ) {
          this.relayDupWarnedAt = { fingerprint, warnedAt: nowMs };
          this.logger.warn(`DHCP atom config has duplicate relay agent IP ${relayAgentIp}; keeping current engine`, {
            jobId,
          });
        }
        return;
      }
      relayAgentIps.add(relayAgentIp);
    }
    this.relayDupWarnedAt = null;

    // Every subnet failed -> keep the last-good engine (fingerprint unchanged) so a corrected
    // atom is retried next tick, rather than tearing down live DHCP over a transient bad edit.
    if (networks.length === 0 && relayed.length === 0) {
      const nowMs = this.nowMs();
      const prev = this.allFailWarnedAt;
      if (
        prev === null ||
        prev.fingerprint !== fingerprint ||
        nowMs - prev.warnedAt >= DhcpServerService.ALL_FAIL_WARN_INTERVAL_MS
      ) {
        this.allFailWarnedAt = { fingerprint, warnedAt: nowMs };
        this.logger.warn('DHCP atom pool validation dropped every subnet; keeping current engine', { jobId });
      }
      return;
    }
    // A successful swap means the config is no longer all-fail; clear the latch.
    this.allFailWarnedAt = null;

    // Engine-level mode is only the no-subnet fallback. Deterministic (no SCAN-order
    // dependence): the shared mode when all non-OFF atoms agree, else AUTHORITATIVE.
    const nonOffModes = new Set(
      [...atoms.values()].map((a) => a.mode).filter((m): m is 'AUTHORITATIVE' | 'PROXY' => m !== 'OFF'),
    );
    const fallbackMode: 'AUTHORITATIVE' | 'PROXY' =
      nonOffModes.size === 1 ? ([...nonOffModes][0] ?? 'AUTHORITATIVE') : 'AUTHORITATIVE';

    const newEngine = DhcpEngine.fromSubnets(
      { mode: fallbackMode, networks, relayed },
      this.now,
      this.leaseStore,
      {
        warn: (message) => this.logger.warn(message, { jobId }),
        error: (message) => this.logger.error(message, { jobId }),
      },
      this.pxeObserver,
    );

    // Seed peer state from the old engine so peer-opt-54 SELECTING REQUESTs aren't dropped
    // in the window before the next reconcile refreshes them.
    const oldEngine = this.engine;
    if (oldEngine !== null) {
      newEngine.setPeerServerIds(oldEngine.getPeerServerIds());
      newEngine.setPeerDnsIp(oldEngine.getPeerDnsIp());
    }

    if (this.hydrated) {
      const ok = await newEngine.hydrate();
      if (!ok) {
        this.logger.warn('DHCP atom hot-swap: hydrate failed on new engine, keeping current', { jobId });
        return;
      }
      newEngine.setWritesEnabled(true);
    }

    // Seed decline backoffs AFTER the hydrate await, immediately before the swap: a DECLINE
    // during that await mutates the still-live old engine, and no await sits before the swap.
    if (oldEngine !== null) {
      newEngine.seedDeclinesFrom(oldEngine);
    }

    this.engineRebuilds.add(1, { reason: this.engine === null ? 'initial' : 'config_change' });
    this.engine = newEngine;
    // Advance the fingerprint only when ALL non-OFF atoms mapped; on partial success leave it
    // unchanged so the next reconcile re-maps (mirrors the empty-path logic above).
    if (mapping.unmappedNonOffCount === 0) {
      this.lastAtomConfigFingerprint = fingerprint;
    }

    // Publish the served-interface set AFTER the successful swap so DNS only binds NICs with
    // a live DHCP engine; the failure paths above keep the prior published set.
    const servedIps = atomServedInterfaceIps(networks);
    this.servedInterfaceNames = new Set(servedIps.map((s) => s.interface));
    this.publishAtomServedIps?.(servedIps, relayedSubnetCidrs(relayed));

    const subnetCount = networks.reduce((n, net) => n + net.subnets.length, 0) + relayed.length;
    this.logger.info(
      `DHCP atom hot-swap: rebuilt engine with ${subnetCount} subnet(s) across ${networks.length} interface(s) + ${relayed.length} relayed`,
      { jobId },
    );
  }

  // Live OFF transition: engine null drops packets and PXE unbinds, but :67 stays
  // bound for hot-standby.
  private tearDownEngine(jobId: string): void {
    if (this.engine === null) return;
    this.engineRebuilds.add(1, { reason: 'teardown' });
    this.engine = null;
    this.hydrated = false;
    this.unbindPort(PXE_PORT, jobId);
    this.logger.info('DHCP atom config empty/all-OFF: engine torn down, packets dropped', { jobId });
  }

  private noteHydrateStall(jobId: string): void {
    if (this.hydrateStalledSinceMs === null) {
      this.hydrateStalledSinceMs = this.nowMs();
    }
    const stalledForMs = this.nowMs() - this.hydrateStalledSinceMs;
    if (stalledForMs > this.leaderTtlSeconds * 1000 && !this.hydrateStallWarned) {
      this.hydrateStallWarned = true;
      this.logger.warn('DHCP leader holds the lock but cannot hydrate; failover is blocked', { jobId });
    }
  }

  getStandbyHealth(): DhcpStandbyHealth {
    const isLeader = this.isLeader();
    return {
      isLeader,
      hydrated: this.hydrated,
      answering: this.engine !== null && isLeader && this.hydrated,
      pxePortBound: this.pxeSocket !== null,
      claimFailureCount: this.claimFailureCount,
      lastClaimError: this.lastClaimError,
      hydrateStalledSince: this.hydrateStalledSinceMs,
      primaryInterface: this.primaryInterface,
    };
  }

  private scheduleHydrateRetry(jobId: string): void {
    if (this.released || this.hydrateRetryTimer !== null) return;
    this.hydrateRetryTimer = setTimeout(() => {
      this.hydrateRetryTimer = null;
      void this.reconcile(jobId);
    }, HYDRATE_RETRY_MS);
    this.hydrateRetryTimer.unref?.();
  }

  private unbindPort(port: number, jobId: string): void {
    const field = port === PXE_PORT ? 'pxeSocket' : 'socket';
    const socket = this[field];
    if (socket !== null) {
      try {
        socket.close();
      } catch (error) {
        void logDebug(`DHCP socket close failed during unbind: ${getErrorMessage(error)}`, { jobId });
      }
      this[field] = null;
    }
  }

  private bindPort(port: number, jobId: string): Promise<void> {
    const socket = this.createSocket();
    const onPxePort = port === PXE_PORT;
    socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      this.handleMessage(socket, msg, rinfo, jobId, onPxePort);
    });

    return new Promise<void>((resolve) => {
      const onError = (error: Error): void => {
        this.logger.error(`DHCP bind failed on ${WILDCARD_ADDRESS}:${port}: ${getErrorMessage(error)}`, { jobId });
        try {
          socket.close();
        } catch (closeError) {
          void logDebug(`DHCP socket close failed after bind error: ${getErrorMessage(closeError)}`, { jobId });
        }
        resolve();
      };
      socket.once('error', onError);
      socket.bind(port, WILDCARD_ADDRESS, () => {
        socket.removeListener('error', onError);
        if (this.released) {
          try {
            socket.close();
          } catch (error) {
            void logDebug(`DHCP socket close failed during release: ${getErrorMessage(error)}`, { jobId });
          }
          resolve();
          return;
        }
        try {
          socket.setBroadcast(true);
        } catch (error) {
          this.logger.warn(`DHCP setBroadcast failed: ${getErrorMessage(error)}`, { jobId });
        }
        socket.on('error', (error: Error) => {
          this.logger.warn(`DHCP socket error: ${getErrorMessage(error)}`, { jobId });
        });
        if (onPxePort) {
          this.pxeSocket = socket;
        } else {
          this.socket = socket;
        }
        this.logger.info(`DHCP listening on ${WILDCARD_ADDRESS}:${port} (serverId ${this.serverId})`, { jobId });
        resolve();
      });
    });
  }

  // Dgram UDP path: unicast renewals, relayed traffic, and broadcast when AF_PACKET is absent.
  private handleMessage(
    socket: dgram.Socket,
    msg: Buffer,
    rinfo: dgram.RemoteInfo,
    jobId: string,
    onPxePort: boolean,
  ): void {
    // Under full AF_PACKET coverage the dgram copy of a broadcast is a duplicate — drop it
    // here; under partial coverage it may be the only copy (see hasFullAfpacketCoverage).
    if (this.hasFullAfpacketCoverage() && !onPxePort && rinfo.address === WILDCARD_ADDRESS) {
      return;
    }

    let request: DhcpMessage;
    try {
      request = parsePacket(msg);
    } catch (error) {
      if (error instanceof DhcpParseError) {
        this.logger.warn(`DHCP malformed packet from ${rinfo.address}: ${getErrorMessage(error)}`, { jobId });
        return;
      }
      this.logger.warn(`DHCP packet handling failed: ${getErrorMessage(error)}`, { jobId });
      return;
    }

    // No IP_PKTINFO on the dgram path — ingress unknown, pass null.
    this.processRequest(request, socket, rinfo, jobId, onPxePort, null);
  }

  private handleAfpacketFrame(ifindex: number, ifname: string, payload: Buffer, jobId: string): void {
    let request: DhcpMessage;
    try {
      request = parsePacket(payload);
    } catch (error) {
      if (error instanceof DhcpParseError) {
        this.logger.warn(`DHCP malformed AF_PACKET frame on ${ifname}: ${getErrorMessage(error)}`, { jobId });
        return;
      }
      this.logger.warn(`DHCP AF_PACKET handling failed on ${ifname}: ${getErrorMessage(error)}`, { jobId });
      return;
    }

    this.processRequest(request, null, null, jobId, false, { ifindex, ifname });
  }

  private processRequest(
    request: DhcpMessage,
    dgramSocket: dgram.Socket | null,
    rinfo: dgram.RemoteInfo | null,
    jobId: string,
    onPxePort: boolean,
    ingressInfo: { ifindex: number; ifname: string } | null,
  ): void {
    const engine = this.engine;
    if (engine === null) return;

    // Sole answer gate (NOT writesEnabled, which only guards lease writes) — this is what
    // makes a standby drop packets.
    if (!this.isLeader() || !this.hydrated) return;

    // Under FULL coverage drop the ingress-less dgram copy of a direct ciaddr==0 request: the L2
    // copy must win the first-copy-wins dedup or groupAllocate flattens subnets; relays/:4011 stay.
    if (
      this.hasFullAfpacketCoverage() &&
      ingressInfo === null &&
      !onPxePort &&
      request.giaddr === ZERO_IP &&
      request.ciaddr === ZERO_IP
    )
      return;

    // A REBINDING REQUEST broadcasts with a non-zero ciaddr source, slipping handleMessage's
    // 0.0.0.0 guard and dual-delivering under AF_PACKET — dedup by identity, first copy wins.
    if (this.packetSockets.size > 0 && !onPxePort) {
      const key = `${request.xid}:${request.chaddr}:${request.messageType}:${request.ciaddr}`;
      const nowMs = this.nowMs();
      const seenUntil = this.recentRequestExpiry.get(key);
      if (seenUntil !== undefined && seenUntil > nowMs) return;
      this.recentRequestExpiry.set(key, nowMs + DUP_WINDOW_MS);
      if (this.recentRequestExpiry.size > DEDUP_MAP_CAP) {
        for (const [k, exp] of this.recentRequestExpiry) if (exp <= nowMs) this.recentRequestExpiry.delete(k);
      }
    }

    let result: DhcpReply | null;
    try {
      result = engine.handle(request, this.serverId, onPxePort, ingressInfo);
    } catch (error) {
      this.logger.warn(`DHCP engine error for ${request.chaddr}: ${getErrorMessage(error)}`, { jobId });
      return;
    }
    if (result === null) return;

    // PXE port replies always go back to the requesting IP via dgram.
    if (onPxePort && dgramSocket !== null && rinfo !== null) {
      const target = { address: rinfo.address, port: rinfo.port };
      sendReply(dgramSocket, result.reply, target, (error) => {
        this.logger.warn(`DHCP send to ${target.address}:${target.port} failed: ${getErrorMessage(error)}`, {
          jobId,
        });
      });
      return;
    }

    // NAKs broadcast per RFC 2131 §4.3.1 (unless relayed). AF_PACKET send only when THIS
    // ingress NIC has a live socket — a failed NIC falls back to dgram.
    const afpacket = ingressInfo !== null && this.packetSockets.has(ingressInfo.ifname);
    const chaddrBuf = macToBuffer(request.chaddr);
    const route =
      result.isNak === true
        ? chooseNakRoute({ giaddr: request.giaddr, afpacketAvailable: afpacket })
        : chooseReplyRoute({
            giaddr: request.giaddr,
            ciaddr: request.ciaddr,
            broadcastFlag: request.broadcast,
            yiaddr: result.yiaddr,
            afpacketAvailable: afpacket,
            chaddr: chaddrBuf,
          });

    this.dispatchReply(route, result, request, dgramSocket, ingressInfo, jobId);
  }

  private dispatchReply(
    route: ReplyTransport,
    result: DhcpReply,
    request: DhcpMessage,
    dgramSocket: dgram.Socket | null,
    ingressInfo: { ifindex: number; ifname: string } | null,
    jobId: string,
  ): void {
    switch (route.kind) {
      case 'dgram-unicast':
      case 'dgram-broadcast': {
        const sendSocket = this.selectDgramSendSocket(dgramSocket, route.target, result.yiaddr, result.sourceIp);
        sendReply(sendSocket, result.reply, route.target, (error) => {
          this.logger.warn(
            `DHCP send to ${route.target.address}:${route.target.port} failed: ${getErrorMessage(error)}`,
            { jobId },
          );
        });
        break;
      }
      case 'afpacket-unicast': {
        const ps = ingressInfo !== null ? this.packetSockets.get(ingressInfo.ifname) : undefined;
        if (ps === undefined) {
          // Fallback: AF_PACKET socket disappeared between route decision and send — dgram broadcast.
          this.sendDgramBroadcastFallback(dgramSocket, result, jobId);
          break;
        }
        try {
          // L3 source: per-subnet serverId (global as fallback) — a multi-subnet host must reply
          // from the subnet's own interface IP or the client may reject/misroute the reply.
          const srcIp = result.sourceIp || this.serverId;
          const frame = buildFrame({
            srcMac: this.resolveLocalMac(ingressInfo.ifname),
            dstMac: route.chaddr,
            srcIp: ipToBuffer(srcIp),
            dstIp: ipToBuffer(result.yiaddr !== ZERO_IP ? result.yiaddr : '255.255.255.255'),
            srcPort: DHCP_SERVER_PORT,
            dstPort: 68,
            payload: result.reply,
          });
          ps.socket.send(ps.ifindex, route.chaddr, frame);
        } catch (error) {
          this.logger.warn(
            `DHCP AF_PACKET unicast to ${request.chaddr} failed: ${getErrorMessage(error)}; falling back to dgram broadcast`,
            { jobId },
          );
          this.sendDgramBroadcastFallback(dgramSocket, result, jobId);
        }
        break;
      }
      case 'afpacket-broadcast': {
        const ps = ingressInfo !== null ? this.packetSockets.get(ingressInfo.ifname) : undefined;
        if (ps === undefined) {
          this.sendDgramBroadcastFallback(dgramSocket, result, jobId);
          break;
        }
        try {
          const srcIp = result.sourceIp || this.serverId;
          const frame = buildFrame({
            srcMac: this.resolveLocalMac(ingressInfo.ifname),
            dstMac: BROADCAST_MAC,
            srcIp: ipToBuffer(srcIp),
            dstIp: ipToBuffer('255.255.255.255'),
            srcPort: DHCP_SERVER_PORT,
            dstPort: 68,
            payload: result.reply,
          });
          ps.socket.send(ps.ifindex, BROADCAST_MAC, frame);
        } catch (error) {
          this.logger.warn(`DHCP AF_PACKET broadcast failed: ${getErrorMessage(error)}; falling back to dgram`, {
            jobId,
          });
          this.sendDgramBroadcastFallback(dgramSocket, result, jobId);
        }
        break;
      }
    }
  }

  private sendDgramBroadcastFallback(dgramSocket: dgram.Socket | null, result: DhcpReply, jobId: string): void {
    const target: ReplyTarget = { address: LIMITED_BROADCAST, port: 68 };
    const sendSocket = this.selectDgramSendSocket(dgramSocket, target, result.yiaddr, result.sourceIp);
    sendReply(sendSocket, result.reply, target, (error) => {
      this.logger.warn(`DHCP dgram fallback send failed: ${getErrorMessage(error)}`, { jobId });
    });
  }

  // Broadcast replies use per-interface send sockets, unicast the receive socket; sourceIp is
  // the lookup fallback when yiaddr is 0.0.0.0 (INFORM/NAK) so the right NIC still sends.
  private selectDgramSendSocket(
    received: dgram.Socket | null,
    target: ReplyTarget,
    yiaddr: string,
    sourceIp: string,
  ): dgram.Socket {
    const fallback = received ?? this.socket;
    if (fallback === null) {
      // Should not happen in practice — the socket is bound before any message arrives.
      throw new Error('no dgram socket available for DHCP reply');
    }
    if (target.address !== LIMITED_BROADCAST || this.replySockets === null) {
      return fallback;
    }
    const lookupIp = yiaddr !== ZERO_IP ? yiaddr : sourceIp || this.serverId;
    return this.replySockets.socketFor(lookupIp) ?? fallback;
  }

  private reconcileAfpacketSockets(jobId: string): void {
    const interfaces = this.resolveInterfaces();

    // Only atom-served NICs get BPF — see servedInterfaceNames (rogue-server risk).
    const served = new Set(
      interfaces.filter((iface) => this.servedInterfaceNames.has(iface.name)).map((iface) => iface.name),
    );

    // Close-de-served runs UNCONDITIONALLY (even when opening is disabled): a de-served NIC
    // must stop receiving/injecting DHCP.
    for (const [name, entry] of this.packetSockets) {
      if (served.has(name)) continue;
      try {
        entry.socket.close();
      } catch (error) {
        void logDebug(`AF_PACKET socket close failed on ${name}: ${getErrorMessage(error)}`, { jobId });
      }
      this.packetSockets.delete(name);
    }

    // Opening needs the addon; once it's confirmed unloadable (host-wide) stop trying + re-logging.
    if (this.afpacketDisabled) {
      return;
    }

    // Covers both the initial probe and a hot-swap that adds a subnet on a new NIC.
    const opened: string[] = [];
    for (const iface of interfaces) {
      if (!served.has(iface.name) || this.packetSockets.has(iface.name)) continue;
      const result = this.createPacketSocket(iface.name);
      if (result.kind === 'addon-unavailable') {
        // Host-wide (missing native module / no CAP_NET_RAW) — disable permanently so we
        // don't re-probe + re-log every reconcile.
        if (!this.afpacketDisabled) {
          this.logger.info(`AF_PACKET unavailable (${result.reason}); using dgram-only DHCP transport`, { jobId });
        }
        this.afpacketDisabled = true;
        break;
      }
      if (result.kind === 'nic-error') {
        // Transient NIC-specific error: retry next reconcile — never disable AF_PACKET host-wide.
        this.logger.warn(`AF_PACKET socket failed on ${iface.name}: ${result.nicError}; will retry next reconcile`, {
          jobId,
        });
        continue;
      }
      const ps = result.socket;
      this.packetSockets.set(iface.name, { socket: ps, ifindex: ps.ifindex });

      const ifname = iface.name;
      ps.onFrame((raw) => {
        try {
          const parsed = parseFrame(raw.frame);
          this.handleAfpacketFrame(raw.ifindex, ifname, parsed.payload, jobId);
        } catch (error) {
          if (error instanceof FrameParseError) {
            this.logger.warn(`DHCP AF_PACKET malformed frame on ${ifname}: ${getErrorMessage(error)}`, { jobId });
            return;
          }
          this.logger.warn(`DHCP AF_PACKET error on ${ifname}: ${getErrorMessage(error)}`, { jobId });
        }
      });
      opened.push(ifname);
    }

    if (opened.length > 0) {
      this.logger.info(`AF_PACKET DHCP transport active on: ${opened.join(', ')}`, { jobId });
    }
  }

  // Full coverage = every served NIC has a live AF_PACKET socket, so a dgram broadcast is a
  // duplicate; under partial coverage the uncovered NIC's broadcasts arrive ONLY via dgram.
  private hasFullAfpacketCoverage(): boolean {
    if (this.packetSockets.size === 0 || this.servedInterfaceNames.size === 0) return false;
    for (const name of this.servedInterfaceNames) {
      if (!this.packetSockets.has(name)) return false;
    }
    return true;
  }

  private closePacketSockets(): void {
    for (const { socket } of this.packetSockets.values()) {
      try {
        socket.close();
      } catch (error) {
        void logDebug(`AF_PACKET socket close failed during shutdown: ${getErrorMessage(error)}`);
      }
    }
    this.packetSockets.clear();
  }

  /** Resolve the local MAC for an interface from the packet socket's ioctl-cached value. */
  private resolveLocalMac(ifname: string): Buffer {
    const ps = this.packetSockets.get(ifname);
    if (ps === undefined) {
      throw new Error(`resolveLocalMac: no AF_PACKET socket for interface ${ifname}`);
    }
    return ps.socket.ifMac;
  }
}

// Covers atoms AND current interface IPs so reconcile rebuilds on either an atom edit or a
// live NIC change; sorted inputs keep the digest deterministic.
function atomConfigFingerprint(
  atoms: ReadonlyMap<string, DhcpAtomValue>,
  interfaces: readonly NetworkInterface[],
): string {
  const atomEntries = [...atoms.entries()].sort(([a], [b]) => a.localeCompare(b));
  // Only name+ip — the fields that affect atom-to-interface mapping.
  const ifaceEntries = [...interfaces].map((i) => [i.name, i.ip] as const).sort(([a], [b]) => a.localeCompare(b));
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([atomEntries, ifaceEntries]))
    .digest('hex');
}

function defaultLogger(): DhcpLogger {
  return {
    info: (message, context) => void logInfo(message, context),
    warn: (message, context) => void logWarning(message, context),
    error: (message, context) => void logError(message, context),
  };
}
