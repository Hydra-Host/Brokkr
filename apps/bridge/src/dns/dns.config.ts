import { hostname as osHostname } from 'node:os';

import { DEFAULT_CACHE_CAPACITY } from './cache.js';

export const DEFAULT_TTL_SECONDS = 60;
export const DEFAULT_UPSTREAM_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 1000;
export const DEFAULT_POLL_MS = 2000;
export const DEFAULT_TCP_MAX_CONNECTIONS = 20;
export const DEFAULT_TCP_MAX_QUERIES_PER_CONN = 100;
export const DEFAULT_TCP_IDLE_TIMEOUT_MS = 5000;
export const DEFAULT_TCP_MAX_MESSAGE_BYTES = 4096;

// Service policy comes exclusively from the hub's `config:dns` atom; the only host-local
// input is the bridge's identity (BRIDGE_HOSTNAME).
export interface DnsConfig {
  enabled: boolean;
  ttlSeconds: number;
  upstreamResolvers: string[];
  upstreamTimeoutMs: number;
  pollMs: number;
  hostname: string;
  ownedDomain: string;
  hostnames: string[];
  cacheSize: number;
  tcpMaxConnections: number;
  tcpMaxQueriesPerConn: number;
  tcpIdleTimeoutMs: number;
  tcpMaxMessageBytes: number;
  maxTtlSeconds: number;
  maxCacheTtlSeconds: number;
  minCacheTtlSeconds: number;
  negTtlSeconds: number;
}

/** Disabled baseline used until the zone's `config:dns` atom arrives (and again if it is withdrawn). */
export function defaultDnsConfig(env: NodeJS.ProcessEnv = process.env): DnsConfig {
  const hostname = env.BRIDGE_HOSTNAME ?? osHostname();
  const hostnames = hostname !== osHostname() ? [hostname, osHostname()] : [osHostname()];

  return {
    enabled: false,
    ttlSeconds: DEFAULT_TTL_SECONDS,
    upstreamResolvers: [],
    upstreamTimeoutMs: DEFAULT_UPSTREAM_TIMEOUT_MS,
    pollMs: DEFAULT_POLL_MS,
    hostname,
    ownedDomain: 'lan',
    hostnames,
    cacheSize: DEFAULT_CACHE_CAPACITY,
    tcpMaxConnections: DEFAULT_TCP_MAX_CONNECTIONS,
    tcpMaxQueriesPerConn: DEFAULT_TCP_MAX_QUERIES_PER_CONN,
    tcpIdleTimeoutMs: DEFAULT_TCP_IDLE_TIMEOUT_MS,
    tcpMaxMessageBytes: DEFAULT_TCP_MAX_MESSAGE_BYTES,
    maxTtlSeconds: 0,
    maxCacheTtlSeconds: 0,
    minCacheTtlSeconds: 0,
    negTtlSeconds: 0,
  };
}
