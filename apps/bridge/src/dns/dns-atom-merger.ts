import type { DnsConfigAtomValue, DnsPrefixOverrideAtomValue } from './dns-atom-value.schema';
import {
  DEFAULT_POLL_MS,
  DEFAULT_TCP_IDLE_TIMEOUT_MS,
  DEFAULT_TCP_MAX_CONNECTIONS,
  DEFAULT_TCP_MAX_MESSAGE_BYTES,
  DEFAULT_TCP_MAX_QUERIES_PER_CONN,
  DEFAULT_UPSTREAM_RESOLVERS,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  type DnsConfig,
} from './dns.config';
import { readResolvConfNameservers } from './resolv-conf';

type UpstreamSelfDiscovery = () => string[];

// An empty atom resolver list means "bridge self-derives" (mirrors the DHCP atom's
// dnsServers/nextServer contract): resolv.conf first, well-known publics as last resort.
function resolveUpstreams(fromAtom: string[], discoverUpstreams: UpstreamSelfDiscovery): string[] {
  if (fromAtom.length > 0) return fromAtom;
  const discovered = discoverUpstreams();
  if (discovered.length > 0) return discovered;
  return [...DEFAULT_UPSTREAM_RESOLVERS];
}

function mergedHostnames(atomHostnames: string[], selfHostnames: string[]): string[] {
  return [...new Set([...atomHostnames, ...selfHostnames])];
}

/** Build a DnsConfig from the zone-global atom. `base` supplies the bridge's own identity
 *  (hostname/hostnames); everything else is atom-carried or a fixed default. */
export function atomToDnsConfig(
  atom: DnsConfigAtomValue,
  base: DnsConfig,
  discoverUpstreams: UpstreamSelfDiscovery = readResolvConfNameservers,
): DnsConfig {
  return {
    enabled: atom.enabled,
    ttlSeconds: atom.ttlSeconds,
    upstreamResolvers: resolveUpstreams(atom.upstreamResolvers, discoverUpstreams),
    upstreamTimeoutMs: atom.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS,
    pollMs: atom.pollMs ?? DEFAULT_POLL_MS,
    hostname: base.hostname,
    ownedDomain: atom.ownedDomain,
    hostnames: mergedHostnames(atom.hostnames, base.hostnames),
    cacheSize: atom.cacheSize,
    tcpMaxConnections: atom.tcpMaxConnections ?? DEFAULT_TCP_MAX_CONNECTIONS,
    tcpMaxQueriesPerConn: atom.tcpMaxQueriesPerConn ?? DEFAULT_TCP_MAX_QUERIES_PER_CONN,
    tcpIdleTimeoutMs: atom.tcpIdleTimeoutMs ?? DEFAULT_TCP_IDLE_TIMEOUT_MS,
    tcpMaxMessageBytes: atom.tcpMaxMessageBytes ?? DEFAULT_TCP_MAX_MESSAGE_BYTES,
    maxTtlSeconds: atom.maxTtlSeconds ?? base.maxTtlSeconds,
    maxCacheTtlSeconds: atom.maxCacheTtlSeconds ?? base.maxCacheTtlSeconds,
    minCacheTtlSeconds: atom.minCacheTtlSeconds ?? base.minCacheTtlSeconds,
    negTtlSeconds: atom.negTtlSeconds ?? base.negTtlSeconds,
  };
}

function sortedArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i++) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

/** Merge per-prefix overrides deterministically (sorted by prefix id): first non-empty
 *  upstreamOverride wins; a force-off override (serveDns=false) never contributes upstreams. */
export function mergePrefixOverrides(
  zoneConfig: DnsConfig,
  overrides: ReadonlyMap<string, DnsPrefixOverrideAtomValue>,
): DnsConfig {
  let upstreamResolvers = zoneConfig.upstreamResolvers;

  const sortedKeys = [...overrides.keys()].sort();
  for (const key of sortedKeys) {
    const override = overrides.get(key)!;
    if (override.serveDns === false) continue;
    if (override.upstreamOverride !== null && override.upstreamOverride.length > 0) {
      upstreamResolvers = override.upstreamOverride;
      break;
    }
  }

  if (upstreamResolvers === zoneConfig.upstreamResolvers) {
    return zoneConfig;
  }

  return { ...zoneConfig, upstreamResolvers };
}

/** True when two DnsConfig values differ in any field that affects runtime behavior. */
export function dnsConfigChanged(a: DnsConfig, b: DnsConfig): boolean {
  if (a.enabled !== b.enabled) return true;
  if (a.ownedDomain !== b.ownedDomain) return true;
  if (!sortedArraysEqual(a.hostnames, b.hostnames)) return true;
  if (a.ttlSeconds !== b.ttlSeconds) return true;
  if (a.cacheSize !== b.cacheSize) return true;
  if (a.upstreamTimeoutMs !== b.upstreamTimeoutMs) return true;
  if (a.pollMs !== b.pollMs) return true;
  if (a.tcpMaxConnections !== b.tcpMaxConnections) return true;
  if (a.tcpMaxQueriesPerConn !== b.tcpMaxQueriesPerConn) return true;
  if (a.tcpIdleTimeoutMs !== b.tcpIdleTimeoutMs) return true;
  if (a.tcpMaxMessageBytes !== b.tcpMaxMessageBytes) return true;
  if (a.maxTtlSeconds !== b.maxTtlSeconds) return true;
  if (a.maxCacheTtlSeconds !== b.maxCacheTtlSeconds) return true;
  if (a.minCacheTtlSeconds !== b.minCacheTtlSeconds) return true;
  if (a.negTtlSeconds !== b.negTtlSeconds) return true;
  if (!sortedArraysEqual(a.upstreamResolvers, b.upstreamResolvers)) return true;
  return false;
}
