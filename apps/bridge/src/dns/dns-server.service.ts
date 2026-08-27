import * as dgram from 'node:dgram';
import * as net from 'node:net';

import { ipInCidr } from '../bridge-network/bridge-ip-resolution.service.js';
import { getErrorMessage } from '../common/error-utils.js';
import { logDebug, logError, logInfo, logWarning } from '../logger/logger.service.js';
import type { BackgroundService } from '../startup/orchestrator.js';

import { DnsCache } from './cache.js';
import { atomToDnsConfig, dnsConfigChanged, mergePrefixOverrides } from './dns-atom-merger.js';
import type { DnsPrefixOverrideAtomValue } from './dns-atom-value.schema.js';
import type { DnsConfigReaderService } from './dns-config-reader.service.js';
import type { DnsRecordsLookup } from './dns-records-reader.js';
import type { DnsConfig } from './dns.config.js';
import {
  type ForwardOptions,
  type UpstreamAffinity,
  ForwardError,
  forwardQuery,
  forwardQueryTcp,
} from './forwarder.js';
import type { InterfaceIp } from './interfaces.js';
import {
  DnsParseError,
  FLAG_QR_RESPONSE,
  FLAG_TC,
  QCLASS_IN,
  QTYPE_A,
  QTYPE_AAAA,
  QTYPE_PTR,
  buildAAAAResponse,
  buildAResponse,
  buildEmptyNoError,
  buildNotImplemented,
  buildNotImplementedHeaderOnly,
  buildNxdomain,
  buildPtrResponse,
  buildServfail,
  clampAnswerTtls,
  parseQuery,
  readOpcode,
  truncateForUdp,
} from './protocol.js';
import { type TcpConn, type TcpServer, handleTcpConnection } from './tcp-listener.js';

const DNS_PORT = 53;
const HEADER_LEN = 12;
const TCP_BACKLOG = 32;

const FAST_RETRY_MS = 100;

const MAX_FAST_RETRIES = 50;

const PRIVATE_IPV4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0a000000, 0x0affffff],
  [0xac100000, 0xac1fffff],
  [0xc0a80000, 0xc0a8ffff],
  [0x7f000000, 0x7fffffff],
];

function ipv4ToUint32(address: string): number | null {
  if (net.isIP(address) !== 4) return null;
  return address.split('.').reduce((acc, octet) => acc * 256 + Number.parseInt(octet, 10), 0) >>> 0;
}

export function isPrivateIpv4(address: string): boolean {
  const value = ipv4ToUint32(address);
  if (value === null) return false;
  return PRIVATE_IPV4_RANGES.some(([lo, hi]) => value >= lo && value <= hi);
}

interface DnsLogger {
  info(message: string, context: { jobId: string }): void;
  warn(message: string, context: { jobId: string }): void;
  error(message: string, context: { jobId: string }): void;
}

type ForwardFn = (query: Buffer, opts: ForwardOptions) => Promise<Buffer>;

type ListInterfacesFn = () => InterfaceIp[];

export interface DnsRecordsReadResult {
  lookup: DnsRecordsLookup;
  domains: ReadonlySet<string>;
}

export interface DnsServerDeps {
  config: DnsConfig;
  listInterfaces?: ListInterfacesFn;
  listServedCidrs?: () => readonly string[];
  forward?: ForwardFn;
  forwardTcp?: ForwardFn;
  hostname?: () => string;
  createSocket?: () => dgram.Socket;
  createTcpServer?: () => TcpServer;
  logger?: DnsLogger;
  configReader?: DnsConfigReaderService;
  readRecords?: (jobId: string) => Promise<DnsRecordsReadResult | null>;
  onPrefixOverrides?: (overrides: ReadonlyMap<string, DnsPrefixOverrideAtomValue>) => void;
  onStop?: () => void | Promise<void>;
}

export function toDnsLabel(hostname: string): string {
  if (!hostname) return '';
  return hostname.split('.')[0].toLowerCase().replace(/_/g, '-');
}

export function buildOwnedNames(host: string, ownedDomain = 'lan', hostnames: string[] = []): Set<string> {
  const domain = ownedDomain || 'lan';
  const names = new Set<string>([`brokkr.${domain}`]);
  const label = toDnsLabel(host);
  if (label && label !== 'brokkr') {
    names.add(`${label}.${domain}`);
  }
  for (const h of hostnames) {
    const hLabel = toDnsLabel(h);
    if (hLabel && !names.has(`${hLabel}.${domain}`)) {
      names.add(`${hLabel}.${domain}`);
    }
  }
  return names;
}

export interface ResolveDeps {
  owned: Set<string>;
  authoritativeSuffix: string;
  ttlSeconds: number;
  upstreams: string[];
  timeoutMs: number;
  forward: ForwardFn;
  forwardTcp?: ForwardFn;
  cache?: DnsCache;
  maxTtlSeconds?: number;
  affinity: UpstreamAffinity;
  logger: DnsLogger;
  jobId: string;
  recordsLookup: DnsRecordsLookup | null;
  recordsDomains?: ReadonlySet<string>;
  servedCidrs?: () => readonly string[];
}

function qnameUnderDomain(qname: string, domains: ReadonlySet<string>): boolean {
  for (const domain of domains) {
    if (qname === domain || qname.endsWith(`.${domain}`)) return true;
  }
  return false;
}

export async function resolveQuery(
  query: Buffer,
  listenIp: string,
  deps: ResolveDeps,
  sourceAddress?: string,
): Promise<Buffer | null> {
  let parsed;
  try {
    parsed = parseQuery(query);
  } catch (error) {
    if (error instanceof DnsParseError) {
      const isResponse = query.length >= HEADER_LEN && (query.readUInt16BE(2) & FLAG_QR_RESPONSE) !== 0;
      if (!isResponse && query.length >= HEADER_LEN && readOpcode(query) !== 0) {
        return buildNotImplementedHeaderOnly(query);
      }
      deps.logger.warn(`DNS malformed query: ${getErrorMessage(error)}`, { jobId: deps.jobId });
      return null;
    }
    throw error;
  }

  const { qname, qtype, qclass, opcode } = parsed;

  if (opcode !== 0) {
    return buildNotImplemented(query);
  }

  if (qclass === QCLASS_IN) {
    if (deps.recordsLookup !== null) {
      const results = deps.recordsLookup.lookup(qname, qtype);
      if (results !== null) {
        const values = results.map((r) => r.value);
        const ttl = Math.min(...results.map((r) => r.ttl ?? deps.ttlSeconds));
        let response: Buffer | null = null;
        if (qtype === QTYPE_A) response = buildAResponse(query, values, ttl);
        else if (qtype === QTYPE_AAAA) response = buildAAAAResponse(query, values, ttl);
        else if (qtype === QTYPE_PTR) response = buildPtrResponse(query, values, ttl);
        if (response !== null) return response;
      } else if (
        deps.recordsLookup.lookup(qname, QTYPE_A) !== null ||
        deps.recordsLookup.lookup(qname, QTYPE_AAAA) !== null ||
        deps.recordsLookup.lookup(qname, QTYPE_PTR) !== null
      ) {
        return buildEmptyNoError(query);
      } else if (
        !deps.owned.has(qname) &&
        deps.recordsDomains !== undefined &&
        qnameUnderDomain(qname, deps.recordsDomains)
      ) {
        return buildNxdomain(query);
      }
    }

    if (deps.owned.has(qname)) {
      if (qtype !== QTYPE_A) return buildEmptyNoError(query);
      return buildAResponse(query, [listenIp], deps.ttlSeconds);
    }

    if (qname.endsWith(deps.authoritativeSuffix)) {
      return buildNxdomain(query);
    }
  }

  if (sourceAddress !== undefined && !isPrivateIpv4(sourceAddress)) {
    const servedSource = deps.servedCidrs?.().some((cidr) => ipInCidr(cidr, sourceAddress)) ?? false;
    if (!servedSource) {
      deps.logger.warn(`DNS dropping recursion for ${qname} from non-private, non-served source ${sourceAddress}`, {
        jobId: deps.jobId,
      });
      return null;
    }
  }

  const cacheable = qclass === QCLASS_IN;
  const cached = cacheable ? deps.cache?.get(qname, qtype, parsed.txnId) : undefined;
  if (cached) {
    return cached;
  }

  try {
    const forwardOpts: ForwardOptions = {
      upstreams: deps.upstreams,
      timeoutMs: deps.timeoutMs,
      affinity: deps.affinity,
    };
    let upstreamBytes = await deps.forward(query, forwardOpts);
    if (deps.forwardTcp && upstreamBytes.length >= HEADER_LEN && (upstreamBytes.readUInt16BE(2) & FLAG_TC) !== 0) {
      try {
        upstreamBytes = await deps.forwardTcp(query, forwardOpts);
      } catch (error) {
        if (!(error instanceof ForwardError)) {
          throw error;
        }
        deps.logger.warn(`DNS TCP retry failed for ${qname}: ${getErrorMessage(error)}`, { jobId: deps.jobId });
      }
    }
    const outBytes = clampAnswerTtls(upstreamBytes, { min: 0, max: deps.maxTtlSeconds ?? 0 });
    if (cacheable) deps.cache?.maybeStore(qname, qtype, outBytes);
    return outBytes;
  } catch (error) {
    if (error instanceof ForwardError) {
      deps.logger.warn(`DNS upstream failed for ${qname}: ${getErrorMessage(error)}`, { jobId: deps.jobId });
      return buildServfail(query);
    }
    throw error;
  }
}

export class DnsServerService implements BackgroundService {
  readonly name = 'dns_server';

  private config: DnsConfig;
  private readonly baseConfig: DnsConfig;
  private readonly configReader: DnsConfigReaderService | null;
  private readonly listInterfaces: ListInterfacesFn;
  private readonly forward: ForwardFn;
  private readonly forwardTcp: ForwardFn;
  private readonly hostname: () => string;
  private readonly createSocket: () => dgram.Socket;
  private readonly createTcpServer: () => TcpServer;
  private readonly logger: DnsLogger;
  private cache?: DnsCache;
  private readonly readRecords?: (jobId: string) => Promise<DnsRecordsReadResult | null>;
  private readonly onPrefixOverrides?: (overrides: ReadonlyMap<string, DnsPrefixOverrideAtomValue>) => void;
  private readonly onStop?: () => void | Promise<void>;
  private currentRecordsLookup: DnsRecordsLookup | null = null;
  private currentRecordsDomains: ReadonlySet<string> = new Set();
  private readonly listServedCidrs: () => readonly string[];

  private readonly liveConns = new Set<TcpConn>();

  private bound = false;
  private pendingBinds = false;
  private fastRetryNoProgress = 0;
  private readonly lastUnboundIps = new Set<string>();
  private warnedUnbound = false;

  private readonly boundUdpIps = new Map<string, dgram.Socket>();
  private readonly boundTcpIps = new Map<string, TcpServer>();
  private readonly failedUdpIps = new Set<string>();
  private readonly failedTcpIps = new Set<string>();

  private readonly affinity: UpstreamAffinity = { udp: -1, tcp: -1 };

  private resolveDeps: ResolveDeps | null = null;

  private reconciling = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private timerFastRetry = false;

  private released = false;
  private releaseFn: (() => void) | null = null;

  constructor(deps: DnsServerDeps) {
    this.config = deps.config;
    this.baseConfig = deps.config;
    this.configReader = deps.configReader ?? null;
    this.listInterfaces = deps.listInterfaces ?? ((): InterfaceIp[] => []);
    this.listServedCidrs = deps.listServedCidrs ?? ((): readonly string[] => []);
    this.forward = deps.forward ?? forwardQuery;
    this.forwardTcp = deps.forwardTcp ?? forwardQueryTcp;
    this.hostname = deps.hostname ?? ((): string => this.config.hostname);
    this.createSocket = deps.createSocket ?? ((): dgram.Socket => dgram.createSocket('udp4'));
    this.createTcpServer = deps.createTcpServer ?? ((): TcpServer => net.createServer());
    this.readRecords = deps.readRecords;
    this.onPrefixOverrides = deps.onPrefixOverrides;
    this.onStop = deps.onStop;
    this.logger = deps.logger ?? defaultLogger();
    this.cache = this.buildCache(this.config);
  }

  async start(jobId: string): Promise<void> {
    this.released = false;
    const owned = buildOwnedNames(this.hostname(), this.config.ownedDomain, this.config.hostnames);
    this.logger.info(`DNS owned names: ${JSON.stringify([...owned].sort())}`, { jobId });
    this.logger.info(
      `DNS upstreams: ${JSON.stringify(this.config.upstreamResolvers)} (timeoutMs=${this.config.upstreamTimeoutMs}, ttl=${this.config.ttlSeconds}s, cacheSize=${this.config.cacheSize})`,
      { jobId },
    );
    this.logger.info('DNS server starting', { jobId });

    await this.reconcile(owned, jobId);
    this.startReconcileTimer(owned, jobId);

    await new Promise<void>((resolve) => {
      if (this.released) {
        resolve();
        return;
      }
      this.releaseFn = resolve;
    });
  }

  async stop(jobId: string): Promise<void> {
    this.released = true;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.closeAllSockets();

    if (this.onStop !== undefined) {
      await this.onStop();
    }

    if (this.releaseFn !== null) {
      const release = this.releaseFn;
      this.releaseFn = null;
      release();
    }

    this.logger.info('DNS server stopped', { jobId });
  }

  private startReconcileTimer(owned: Set<string>, jobId: string): void {
    if (this.released) return;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const fast = !this.bound || this.pendingBinds;
    this.timerFastRetry = fast;
    const intervalMs = fast ? FAST_RETRY_MS : this.config.pollMs;
    this.pollTimer = setInterval(() => {
      void this.reconcile(owned, jobId).then(() => {
        if (this.pollTimer === null) return;
        const needsFast = !this.bound || this.pendingBinds;
        if (needsFast !== this.timerFastRetry) {
          clearInterval(this.pollTimer);
          this.pollTimer = null;
          this.startReconcileTimer(owned, jobId);
        }
      });
    }, intervalMs);
    this.pollTimer.unref?.();
  }

  private async reconcile(owned: Set<string>, jobId: string): Promise<void> {
    if (this.reconciling || this.released) return;
    this.reconciling = true;
    try {
      await this.maybeRefreshConfig(owned, jobId);
      if (this.readRecords !== undefined) {
        const result = await this.readRecords(jobId);
        this.currentRecordsLookup = result?.lookup ?? null;
        this.currentRecordsDomains = result?.domains ?? new Set();
        if (this.resolveDeps !== null) {
          this.resolveDeps.recordsLookup = this.currentRecordsLookup;
          this.resolveDeps.recordsDomains = this.currentRecordsDomains;
        }
      }
      await this.bindInterfaces(owned, jobId);
    } catch (error) {
      this.logger.warn(`DNS reconcile failed: ${getErrorMessage(error)}`, { jobId });
    } finally {
      this.reconciling = false;
    }
  }

  private async maybeRefreshConfig(owned: Set<string>, jobId: string): Promise<void> {
    if (this.configReader === null) return;

    const result = await this.configReader.readZoneConfig(jobId);
    if (result.reason === 'error') return;

    let newConfig: DnsConfig;
    if (result.ok) {
      newConfig = atomToDnsConfig(result.config, this.baseConfig);
      // A transient read failure must not strip previously applied overrides — keep the current
      // config, like the zone-config error path above.
      const prefixResult = await this.configReader.readPrefixOverrides(jobId);
      if (!prefixResult.ok) return;
      this.onPrefixOverrides?.(prefixResult.overrides);
      if (prefixResult.overrides.size > 0) {
        newConfig = mergePrefixOverrides(newConfig, prefixResult.overrides);
      }
    } else {
      // Zone atom withdrawn (e.g. zone deleted): fall back to the disabled baseline; per-prefix
      // atoms that outlive the zone atom (cleared only by the reconcile cron) must not steer it.
      newConfig = this.baseConfig;
    }

    if (!dnsConfigChanged(this.config, newConfig)) return;

    this.logger.info('DNS config changed via atom; applying live reconfiguration', { jobId });

    const enabledChanged = this.config.enabled !== newConfig.enabled;
    const pollChanged = this.config.pollMs !== newConfig.pollMs;
    const cacheParamsChanged =
      this.config.cacheSize !== newConfig.cacheSize ||
      this.config.maxCacheTtlSeconds !== newConfig.maxCacheTtlSeconds ||
      this.config.minCacheTtlSeconds !== newConfig.minCacheTtlSeconds ||
      this.config.negTtlSeconds !== newConfig.negTtlSeconds;

    this.config = newConfig;

    owned.clear();
    for (const name of buildOwnedNames(this.hostname(), newConfig.ownedDomain, newConfig.hostnames)) {
      owned.add(name);
    }

    if (cacheParamsChanged) {
      this.cache = this.buildCache(newConfig);
    } else {
      this.cache?.clear();
    }

    this.affinity.udp = -1;
    this.affinity.tcp = -1;
    this.resolveDeps = null;

    if (enabledChanged && !newConfig.enabled) {
      this.closeAllSockets();
    }
    if (pollChanged && this.pollTimer !== null) {
      this.startReconcileTimer(owned, jobId);
    }
  }

  private buildCache(cfg: DnsConfig): DnsCache | undefined {
    if (cfg.cacheSize <= 0) return undefined;
    return new DnsCache({
      capacity: cfg.cacheSize,
      maxCacheTtlSeconds: cfg.maxCacheTtlSeconds,
      minCacheTtlSeconds: cfg.minCacheTtlSeconds,
      negTtlSeconds: cfg.negTtlSeconds,
    });
  }

  private async bindInterfaces(owned: Set<string>, jobId: string): Promise<void> {
    if (!this.config.enabled) return;

    const resolveDeps = this.resolveDeps ?? this.buildResolveDeps(owned, jobId);
    this.resolveDeps = resolveDeps;

    const entries = this.listInterfaces();
    if (entries.length === 0 && this.bound) {
      this.logger.warn('DNS listen-interface set is empty; server will answer no queries until interfaces appear', {
        jobId,
      });
    }
    const liveIps = new Set(entries.map((e) => e.ip));

    this.unbindDepartedIps(liveIps, jobId);

    if (this.boundUdpIps.size === 0 && this.boundTcpIps.size === 0) {
      this.bound = false;
    }

    let newUdp = 0;
    for (const entry of entries) {
      if (this.released) {
        this.closeAllSockets();
        return;
      }
      if (this.boundUdpIps.has(entry.ip)) continue;
      const socket = await this.bindOne(entry, resolveDeps, jobId, !this.failedUdpIps.has(entry.ip));
      if (socket !== null) {
        this.boundUdpIps.set(entry.ip, socket);
        this.failedUdpIps.delete(entry.ip);
        newUdp += 1;
      } else {
        this.failedUdpIps.add(entry.ip);
      }
    }

    let newTcp = 0;
    for (const entry of entries) {
      if (this.released) {
        this.closeAllSockets();
        return;
      }
      if (this.boundTcpIps.has(entry.ip)) continue;
      const server = await this.bindTcpOne(entry, resolveDeps, jobId, !this.failedTcpIps.has(entry.ip));
      if (server !== null) {
        this.boundTcpIps.set(entry.ip, server);
        this.failedTcpIps.delete(entry.ip);
        newTcp += 1;
      } else {
        this.failedTcpIps.add(entry.ip);
      }
    }

    if (this.released) {
      this.closeAllSockets();
      return;
    }
    if (newUdp + newTcp > 0) {
      this.bound = true;
      this.warnedUnbound = false;
      this.logger.info(`DNS server bound ${newUdp} UDP + ${newTcp} TCP new listener(s) on :${DNS_PORT}`, { jobId });
    } else if (!this.bound && !this.warnedUnbound) {
      this.warnedUnbound = true;
      this.logger.warn('DNS server found no interfaces to bind yet; will retry next reconcile', { jobId });
    }

    const unboundIps = entries
      .filter((e) => !this.boundUdpIps.has(e.ip) || !this.boundTcpIps.has(e.ip))
      .map((e) => e.ip);
    const hasUnbound = unboundIps.length > 0;
    const newPending = unboundIps.some((ip) => !this.lastUnboundIps.has(ip));
    if (!hasUnbound || newUdp + newTcp > 0 || newPending) {
      this.fastRetryNoProgress = 0;
    } else {
      this.fastRetryNoProgress += 1;
    }
    this.lastUnboundIps.clear();
    for (const ip of unboundIps) this.lastUnboundIps.add(ip);
    this.pendingBinds = hasUnbound && this.fastRetryNoProgress < MAX_FAST_RETRIES;
  }

  private unbindDepartedIps(liveIps: Set<string>, jobId: string): void {
    for (const [ip, socket] of this.boundUdpIps) {
      if (liveIps.has(ip)) continue;
      try {
        socket.close();
      } catch (error) {
        void logDebug(`DNS UDP socket close failed on ${ip}: ${getErrorMessage(error)}`, { jobId });
      }
      this.boundUdpIps.delete(ip);
      this.failedUdpIps.delete(ip);
      this.logger.info(`DNS unbound departed UDP listener on ${ip}:${DNS_PORT}`, { jobId });
    }
    for (const [ip, server] of this.boundTcpIps) {
      if (liveIps.has(ip)) continue;
      try {
        server.close();
      } catch (error) {
        void logDebug(`DNS TCP server close failed on ${ip}: ${getErrorMessage(error)}`, { jobId });
      }
      this.boundTcpIps.delete(ip);
      this.failedTcpIps.delete(ip);
      this.logger.info(`DNS unbound departed TCP listener on ${ip}:${DNS_PORT}`, { jobId });
    }
  }

  private closeAllSockets(): void {
    for (const socket of this.boundUdpIps.values()) {
      try {
        socket.close();
      } catch (error) {
        void logDebug(`DNS UDP socket close failed during shutdown: ${getErrorMessage(error)}`);
      }
    }
    for (const server of this.boundTcpIps.values()) {
      try {
        server.close();
      } catch (error) {
        void logDebug(`DNS TCP server close failed during shutdown: ${getErrorMessage(error)}`);
      }
    }
    for (const conn of this.liveConns) {
      try {
        conn.destroy();
      } catch (error) {
        void logDebug(`DNS TCP connection destroy failed during shutdown: ${getErrorMessage(error)}`);
      }
    }
    this.liveConns.clear();
    this.boundUdpIps.clear();
    this.boundTcpIps.clear();
    this.failedUdpIps.clear();
    this.failedTcpIps.clear();

    this.bound = false;
    this.timerFastRetry = false;
    this.pendingBinds = false;
    this.fastRetryNoProgress = 0;
    this.lastUnboundIps.clear();
    this.warnedUnbound = false;
    this.resolveDeps = null;
    this.currentRecordsLookup = null;
    this.currentRecordsDomains = new Set();
  }

  private buildResolveDeps(owned: Set<string>, jobId: string): ResolveDeps {
    return {
      owned,
      authoritativeSuffix: `.${this.config.ownedDomain || 'lan'}`,
      ttlSeconds: this.config.ttlSeconds,
      upstreams: this.config.upstreamResolvers,
      timeoutMs: this.config.upstreamTimeoutMs,
      forward: this.forward,
      forwardTcp: this.forwardTcp,
      cache: this.cache,
      maxTtlSeconds: this.config.maxTtlSeconds,
      affinity: this.affinity,
      logger: this.logger,
      jobId,
      recordsLookup: this.currentRecordsLookup,
      recordsDomains: this.currentRecordsDomains,
      servedCidrs: this.listServedCidrs,
    };
  }

  private bindOne(
    entry: InterfaceIp,
    resolveDeps: ResolveDeps,
    jobId: string,
    logFailure = true,
  ): Promise<dgram.Socket | null> {
    const listenIp = entry.ip;
    const socket = this.createSocket();

    socket.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
      const deps = this.resolveDeps ?? resolveDeps;
      void this.handleMessage(socket, msg, rinfo, listenIp, deps);
    });

    return new Promise<dgram.Socket | null>((resolve) => {
      const onError = (error: Error): void => {
        if (logFailure) {
          this.logger.error(
            `DNS bind failed on ${entry.interface} ${listenIp}:${DNS_PORT}: ${getErrorMessage(error)}`,
            { jobId },
          );
        }
        try {
          socket.close();
        } catch (closeError) {
          void logDebug(`DNS socket close failed after bind error: ${getErrorMessage(closeError)}`, { jobId });
        }
        resolve(null);
      };
      socket.once('error', onError);
      socket.bind(DNS_PORT, listenIp, () => {
        socket.removeListener('error', onError);
        if (this.released) {
          try {
            socket.close();
          } catch (error) {
            void logDebug(`DNS socket close failed during release: ${getErrorMessage(error)}`, { jobId });
          }
          resolve(null);
          return;
        }
        socket.on('error', (error: Error) => {
          this.logger.warn(`DNS socket error on ${listenIp}: ${getErrorMessage(error)}`, { jobId });
        });
        this.logger.info(`DNS listening on ${entry.interface} ${listenIp}:${DNS_PORT}`, { jobId });
        if (!isPrivateIpv4(listenIp)) {
          this.logger.warn(
            `DNS bound to non-private IP ${entry.interface} ${listenIp}; expected an isolated provisioning subnet — verify :53 is firewalled`,
            { jobId },
          );
        }
        resolve(socket);
      });
    });
  }

  private bindTcpOne(
    entry: InterfaceIp,
    resolveDeps: ResolveDeps,
    jobId: string,
    logFailure = true,
  ): Promise<TcpServer | null> {
    const listenIp = entry.ip;
    const server = this.createTcpServer();

    server.on('connection', (conn: TcpConn) => {
      if (this.released) {
        conn.destroy();
        return;
      }
      if (this.liveConns.size >= this.config.tcpMaxConnections) {
        this.logger.warn(`DNS TCP connection limit reached on ${listenIp}; dropping connection`, { jobId });
        conn.destroy();
        return;
      }
      this.liveConns.add(conn);
      conn.on('close', () => {
        this.liveConns.delete(conn);
      });
      const connListenIp = conn.localAddress ?? listenIp;
      handleTcpConnection(conn, {
        resolve: (q, ip) => resolveQuery(q, ip, this.resolveDeps ?? resolveDeps, conn.remoteAddress ?? ''),
        listenIp: connListenIp,
        maxMessageBytes: this.config.tcpMaxMessageBytes,
        idleTimeoutMs: this.config.tcpIdleTimeoutMs,
        maxQueriesPerConn: this.config.tcpMaxQueriesPerConn,
        logger: this.logger,
        jobId,
      });
    });

    return new Promise<TcpServer | null>((resolve) => {
      let bound = false;
      server.on('error', (error: Error) => {
        if (bound) {
          this.logger.warn(`DNS TCP server error on ${listenIp}: ${getErrorMessage(error)}`, { jobId });
          return;
        }
        if (logFailure) {
          this.logger.error(
            `DNS TCP bind failed on ${entry.interface} ${listenIp}:${DNS_PORT}: ${getErrorMessage(error)}`,
            { jobId },
          );
        }
        try {
          server.close();
        } catch (closeError) {
          void logDebug(`DNS TCP server close failed after bind error: ${getErrorMessage(closeError)}`, { jobId });
        }
        resolve(null);
      });
      server.listen(DNS_PORT, listenIp, TCP_BACKLOG, () => {
        if (this.released) {
          try {
            server.close();
          } catch (error) {
            void logDebug(`DNS TCP server close failed during release: ${getErrorMessage(error)}`, { jobId });
          }
          resolve(null);
          return;
        }
        bound = true;
        this.logger.info(`DNS TCP listening on ${entry.interface} ${listenIp}:${DNS_PORT}`, { jobId });
        resolve(server);
      });
    });
  }

  private async handleMessage(
    socket: dgram.Socket,
    msg: Buffer,
    rinfo: dgram.RemoteInfo,
    listenIp: string,
    resolveDeps: ResolveDeps,
  ): Promise<void> {
    try {
      const resolved = await resolveQuery(msg, listenIp, resolveDeps, rinfo.address);
      if (resolved !== null) {
        const response = truncateForUdp(resolved);
        socket.send(response, rinfo.port, rinfo.address, (error) => {
          if (error) {
            this.logger.warn(`DNS send to ${rinfo.address}:${rinfo.port} failed: ${getErrorMessage(error)}`, {
              jobId: resolveDeps.jobId,
            });
          }
        });
      }
    } catch (error) {
      this.logger.warn(`DNS message handling failed: ${getErrorMessage(error)}`, { jobId: resolveDeps.jobId });
    }
  }
}

function defaultLogger(): DnsLogger {
  return {
    info: (message, context) => void logInfo(message, context),
    warn: (message, context) => void logWarning(message, context),
    error: (message, context) => void logError(message, context),
  };
}
