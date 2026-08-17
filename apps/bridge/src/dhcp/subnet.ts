import { type DhcpMode, type DhcpOptionSpec, type DhcpReservation, intToIp, ipToInt } from './dhcp.config.js';
import type { LeaseRecord } from './lease-store/lease-record.js';

/** Per-subnet in-memory lease entry. */
export interface SubnetLease {
  ip: string;
  mac: string;
  expiresAt: number;
}

/** A contiguous range of IPs within a subnet's dynamic allocation pools. */
export interface PoolRange {
  start: number;
  end: number;
}

/** Each field maps to the hub DHCP atom schema so the atom mapper can produce these directly. */
export interface SubnetConfig {
  /** Per-subnet DHCP mode: AUTHORITATIVE, PROXY, or OFF. */
  mode?: DhcpMode;
  /** Relay agent IP that selects this subnet. */
  relayAgentIp?: string;
  /** Dotted-quad subnet mask, e.g. "255.255.255.0". */
  subnetMask: string;
  cidr?: string;
  /** First IP of the dynamic pool (empty string = reservations-only). */
  rangeStart: string;
  /** Last IP of the dynamic pool (empty string = reservations-only). */
  rangeEnd: string;
  pools?: PoolRange[];
  /** MAC->IP reservations. */
  reservations: DhcpReservation[];
  /** IPs excluded from dynamic allocation (gateway, serverId, etc.). */
  excludeIps: string[];
  /** Default routers advertised to clients on this subnet. */
  routers: string[];
  /** DNS servers advertised to clients on this subnet. */
  dnsServers: string[];
  /** Lease duration in seconds. */
  leaseTtlSeconds: number;
  /** DECLINE backoff in seconds (0 = permanent block). */
  declineBackoffSeconds: number;

  // Boot fields — per-subnet so different subnets can PXE-boot differently.
  tftpServer: string;
  bootfile: string;
  bootfileByArch: Map<number, string>;
  bootBootfile: string;
  bootServerName: string;
  bootServerAddress: string;

  // Operator DHCP options.
  dhcpOptions: DhcpOptionSpec[];

  // DNS self-reference.
  dnsSelf: boolean;

  /** ServerId for this subnet — used for network/broadcast derivation. */
  serverId: string;

  /** MACs permitted to PXE-boot when this subnet is PROXY mode. Empty = deny-all (fail-closed).
   *  Undefined/missing = feature off (allow-all). Only gates PROXY replies. */
  proxyAllowedMacs?: Set<string>;
}

export interface SubnetLogger {
  warn(message: string): void;
}

export class Subnet {
  readonly networkInt: number;
  readonly broadcastInt: number;
  readonly subnetMask: string;
  readonly config: SubnetConfig;
  /** CIDR string identifying this subnet — the low-cardinality metric label. */
  readonly cidr: string;
  /** Static allocatable capacity, computed once per build (see computePoolSize). */
  readonly poolSize: number;

  // Per-subnet lease state — private to enforce atomic updates via
  // commitLease/forgetMac (the two maps must always stay in lockstep).
  private readonly leasesByMac = new Map<string, SubnetLease>();
  private readonly macByIp = new Map<string, string>();
  readonly blockedUntil = new Map<string, number>();

  private readonly reservedByMac: Map<string, string>;
  private readonly reservedIps: Set<string>;
  private readonly excludeIps: Set<string>;
  /** Per-device iPXE bootfile overrides, keyed by reserved MAC (subset of reservedByMac). */
  readonly bootByMac = new Map<string, { bootfile: string; bootfileByArch: Map<number, string> }>();
  /** Ordered list of dynamic pools; allocation iterates in order (first free wins). */
  private readonly pools: readonly PoolRange[];

  constructor(
    config: SubnetConfig,
    private readonly now: () => number,
    private readonly logger?: SubnetLogger,
  ) {
    this.config = config;
    this.subnetMask = config.subnetMask;
    this.reservedByMac = new Map(config.reservations.map((r) => [r.mac, r.ip]));
    this.reservedIps = new Set(config.reservations.map((r) => r.ip));
    this.excludeIps = new Set(config.excludeIps);
    for (const r of config.reservations) {
      if (r.bootfile !== undefined) {
        this.bootByMac.set(r.mac, { bootfile: r.bootfile, bootfileByArch: r.bootfileByArch ?? new Map() });
      }
    }

    // Build pools[] — explicit multi-pool config takes precedence; single rangeStart/rangeEnd
    // is normalized into a one-element array so all allocation goes through the same path.
    if (config.pools !== undefined && config.pools.length > 0) {
      this.pools = config.pools;
    } else {
      const start = config.rangeStart ? ipToInt(config.rangeStart) : 0;
      const end = config.rangeEnd ? ipToInt(config.rangeEnd) : -1;
      this.pools = [{ start, end }];
    }

    const mask = ipToInt(config.subnetMask);
    // Reservations-only pools have start=0, which would make networkInt=0 and NAK every
    // on-subnet renewal; derive the network from serverId when a range isn't set.
    const firstPool = this.pools[0];
    const netSource = config.serverId !== '' ? ipToInt(config.serverId) : firstPool !== undefined ? firstPool.start : 0;
    this.networkInt = (netSource & mask) >>> 0;
    this.broadcastInt = (this.networkInt | (~mask >>> 0)) >>> 0;
    // IPv4 masks are contiguous, so prefix length = leading-1-bit count = clz32(~mask).
    // Correct at both extremes: /32 (~mask=0→32) and /0 (~mask=0xffffffff→0).
    this.cidr = `${intToIp(this.networkInt)}/${Math.clz32(~mask >>> 0)}`;
    this.poolSize = this.computePoolSize();
  }

  // Pool addresses minus in-pool network/broadcast/excluded, plus out-of-pool reservations
  // (in-pool ones already counted). Lease/decline state plays no part.
  private computePoolSize(): number {
    let size = 0;
    for (const pool of this.pools) {
      if (pool.end < pool.start) continue;
      size += pool.end - pool.start + 1;
    }
    const unallocatable = new Set<number>([this.networkInt, this.broadcastInt]);
    for (const ip of this.excludeIps) unallocatable.add(ipToInt(ip));
    for (const n of unallocatable) {
      if (this.inPoolInt(n)) size -= 1;
    }
    for (const ip of this.reservedIps) {
      if (!this.excludeIps.has(ip) && !this.inPoolInt(ipToInt(ip))) size += 1;
    }
    return size;
  }

  /** Non-expired leases in the in-RAM map (expired entries linger until prune). */
  activeLeaseCount(): number {
    const now = this.now();
    let count = 0;
    for (const lease of this.leasesByMac.values()) {
      if (lease.expiresAt > now) count += 1;
    }
    return count;
  }

  /** Deliberately preserves blockedUntil: hot-swap hydrate redistributes leases from the
   *  shared store but must NOT drop in-flight decline backoffs. */
  resetLeaseIndexes(): void {
    this.leasesByMac.clear();
    this.macByIp.clear();
  }

  /** True when `ip` falls within this subnet's CIDR. */
  containsIp(ip: string): boolean {
    const n = ipToInt(ip);
    const mask = ipToInt(this.subnetMask);
    return (n & mask) >>> 0 === this.networkInt;
  }

  /** True when `mac` has a live (non-expired) lease or reservation in this subnet. */
  hasBindingForMac(mac: string): boolean {
    if (this.reservedByMac.has(mac)) return true;
    const lease = this.leasesByMac.get(mac);
    return lease !== undefined && lease.expiresAt > this.now();
  }

  // ---- Address selection (moved from DhcpEngine, unchanged logic) ----

  selectAddress(mac: string, hint: string | null, poolHint: string | null = null): string | null {
    const reserved = this.reservedByMac.get(mac);
    if (reserved !== undefined) {
      if (this.isBlocked(reserved) || this.excludeIps.has(reserved) || this.heldByOther(reserved, mac)) {
        return null;
      }
      return reserved;
    }

    const existing = this.leasesByMac.get(mac);
    if (existing !== undefined && this.hintUsable(existing.ip, mac)) return existing.ip;

    if (hint !== null && this.hintUsable(hint, mac)) return hint;

    // poolHint (a free address groupAllocate already found) is still validated via hintUsable
    // to guard against a concurrent commit between the scan and this call.
    if (poolHint !== null && this.hintUsable(poolHint, mac)) return poolHint;

    return this.nextFreePoolAddress();
  }

  hintUsable(ip: string, mac: string): boolean {
    if (!this.inPool(ip)) return false;
    if (this.reservedIps.has(ip)) return false;
    if (this.excludeIps.has(ip)) return false;
    if (this.isBlocked(ip)) return false;
    return !this.heldByOther(ip, mac);
  }

  inPool(ip: string): boolean {
    return this.inPoolInt(ipToInt(ip));
  }

  private inPoolInt(n: number): boolean {
    for (const pool of this.pools) {
      if (pool.end < pool.start) continue;
      if (n >= pool.start && n <= pool.end) return true;
    }
    return false;
  }

  onSubnet(ip: string): boolean {
    const mask = ipToInt(this.subnetMask);
    return (ipToInt(ip) & mask) >>> 0 === this.networkInt;
  }

  manages(ip: string, mac: string): boolean {
    if (this.reservedByMac.get(mac) === ip) return true;
    return this.inPool(ip);
  }

  heldByOther(ip: string, mac: string): boolean {
    const holder = this.macByIp.get(ip);
    if (holder === undefined || holder === mac) return false;
    const lease = this.leasesByMac.get(holder);
    return lease !== undefined && lease.expiresAt > this.now();
  }

  holdsActiveBinding(mac: string, ip: string): boolean {
    const lease = this.leasesByMac.get(mac);
    return lease !== undefined && lease.ip === ip && lease.expiresAt > this.now();
  }

  isBlocked(ip: string): boolean {
    const until = this.blockedUntil.get(ip);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.blockedUntil.delete(ip);
      return false;
    }
    return true;
  }

  block(ip: string): void {
    const backoff = this.config.declineBackoffSeconds;
    const until = backoff <= 0 ? Number.POSITIVE_INFINITY : this.now() + backoff;
    this.blockedUntil.set(ip, until);
  }

  hasReservation(mac: string): boolean {
    return this.reservedByMac.has(mac);
  }

  hasLease(mac: string): boolean {
    return this.leasesByMac.has(mac);
  }

  isExcluded(ip: string): boolean {
    return this.excludeIps.has(ip);
  }

  nextFreePoolAddress(): string | null {
    const now = this.now();
    for (const pool of this.pools) {
      if (pool.end < pool.start) continue;
      for (let n = pool.start; n <= pool.end; n++) {
        if (n === this.networkInt || n === this.broadcastInt) continue;
        const ip = intToIp(n);
        if (this.reservedIps.has(ip)) continue;
        if (this.excludeIps.has(ip)) continue;
        if (this.isBlocked(ip)) continue;
        const holder = this.macByIp.get(ip);
        if (holder === undefined) return ip;
        const lease = this.leasesByMac.get(holder);
        if (lease === undefined || lease.expiresAt <= now) return ip;
      }
    }
    return null;
  }

  /** Clear all in-RAM lease state (used on leadership loss). */
  resetLeaseState(): void {
    this.leasesByMac.clear();
    this.macByIp.clear();
    this.blockedUntil.clear();
  }

  /** Ingest a lease record (from hydrate). Returns true if the IP belongs to this subnet. */
  adoptLease(record: LeaseRecord): boolean {
    if (!this.containsIp(record.ip)) return false;
    this.leasesByMac.set(record.mac, {
      ip: record.ip,
      mac: record.mac,
      expiresAt: record.expiresAt,
    });
    this.macByIp.set(record.ip, record.mac);
    return true;
  }

  // ---- Public lease accessors (used by DhcpEngine without touching the maps) ----

  /** Return the lease for `mac`, or undefined if none exists. */
  leaseFor(mac: string): SubnetLease | undefined {
    return this.leasesByMac.get(mac);
  }

  /** Return the MAC that currently owns `ip`, or undefined. */
  ipOwner(ip: string): string | undefined {
    return this.macByIp.get(ip);
  }

  // ---- Atomic lease mutations (keep leasesByMac + macByIp in lockstep) ----

  commitLease(mac: string, ip: string, expiresAt: number): void {
    this.leasesByMac.set(mac, { ip, mac, expiresAt });
    this.macByIp.set(ip, mac);
  }

  reclaimPriorIp(mac: string, newIp: string): SubnetLease | null {
    const prior = this.leasesByMac.get(mac);
    if (prior && prior.ip !== newIp && this.macByIp.get(prior.ip) === mac) {
      this.macByIp.delete(prior.ip);
      return prior;
    }
    return null;
  }

  forgetMac(mac: string, declinedIp: string | null = null): SubnetLease | null {
    const lease = this.leasesByMac.get(mac);
    if (lease) {
      this.macByIp.delete(lease.ip);
      this.leasesByMac.delete(mac);
    }
    if (declinedIp !== null) {
      this.macByIp.delete(declinedIp);
    }
    return lease ?? null;
  }

  broadcastAddress(yiaddr: string): string {
    const mask = ipToInt(this.subnetMask);
    const net = ipToInt(yiaddr) & mask;
    return intToIp((net | (~mask >>> 0)) >>> 0);
  }

  leases(): SubnetLease[] {
    return [...this.leasesByMac.values()];
  }
}
