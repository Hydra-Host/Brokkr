import { describe, expect, it, vi } from 'vitest';

import { atomToDnsConfig, dnsConfigChanged, mergePrefixOverrides } from '../dns-atom-merger';
import type { DnsConfigAtomValue, DnsPrefixOverrideAtomValue } from '../dns-atom-value.schema';
import {
  DEFAULT_POLL_MS,
  DEFAULT_TCP_IDLE_TIMEOUT_MS,
  DEFAULT_TCP_MAX_CONNECTIONS,
  DEFAULT_TCP_MAX_MESSAGE_BYTES,
  DEFAULT_TCP_MAX_QUERIES_PER_CONN,
  DEFAULT_UPSTREAM_TIMEOUT_MS,
  defaultDnsConfig,
  type DnsConfig,
} from '../dns.config';

const ZONE: DnsConfigAtomValue = {
  enabled: true,
  upstreamResolvers: ['1.1.1.1', '8.8.8.8'],
  ttlSeconds: 60,
  cacheSize: 4096,
  ownedDomain: 'lan',
  hostnames: ['bridge-1'],
  upstreamTimeoutMs: 1500,
  pollMs: 3000,
  tcpMaxConnections: 20,
  tcpMaxQueriesPerConn: 100,
  tcpIdleTimeoutMs: 5000,
  tcpMaxMessageBytes: 4096,
  maxTtlSeconds: 86400,
  maxCacheTtlSeconds: 3600,
  minCacheTtlSeconds: 10,
  negTtlSeconds: 30,
};

function makeBase(overrides: Partial<DnsConfig> = {}): DnsConfig {
  return {
    ...defaultDnsConfig({ BRIDGE_HOSTNAME: 'bridge-01' }),
    hostnames: ['bridge-01'],
    ...overrides,
  };
}

const BASE = makeBase();

describe('atomToDnsConfig', () => {
  it('maps atom fields onto DnsConfig, keeping only identity from base', () => {
    const result = atomToDnsConfig(ZONE, BASE);
    expect(result.enabled).toBe(ZONE.enabled);
    expect(result.ownedDomain).toBe(ZONE.ownedDomain);
    expect(result.ttlSeconds).toBe(ZONE.ttlSeconds);
    expect(result.upstreamResolvers).toEqual(ZONE.upstreamResolvers);
    expect(result.cacheSize).toBe(ZONE.cacheSize);
    expect(result.upstreamTimeoutMs).toBe(ZONE.upstreamTimeoutMs);
    expect(result.pollMs).toBe(ZONE.pollMs);
    expect(result.tcpMaxConnections).toBe(ZONE.tcpMaxConnections);
    expect(result.tcpMaxQueriesPerConn).toBe(ZONE.tcpMaxQueriesPerConn);
    expect(result.tcpIdleTimeoutMs).toBe(ZONE.tcpIdleTimeoutMs);
    expect(result.tcpMaxMessageBytes).toBe(ZONE.tcpMaxMessageBytes);
    expect(result.maxTtlSeconds).toBe(ZONE.maxTtlSeconds);
    expect(result.maxCacheTtlSeconds).toBe(ZONE.maxCacheTtlSeconds);
    expect(result.minCacheTtlSeconds).toBe(ZONE.minCacheTtlSeconds);
    expect(result.negTtlSeconds).toBe(ZONE.negTtlSeconds);

    expect(result.hostname).toBe(BASE.hostname);
  });

  it('unions atom hostnames (zone bridges) with base hostnames (local identity)', () => {
    const base = makeBase({ hostnames: ['bridge-01', 'bridge-01.local'] });
    const result = atomToDnsConfig(ZONE, base);
    expect(result.hostnames).toEqual(['bridge-1', 'bridge-01', 'bridge-01.local']);
  });

  it('deduplicates the hostname union', () => {
    const base = makeBase({ hostnames: ['bridge-01'] });
    const result = atomToDnsConfig({ ...ZONE, hostnames: ['bridge-01', 'zone-x'] }, base);
    expect(result.hostnames).toEqual(['bridge-01', 'zone-x']);
  });

  it('falls back to fixed defaults for omitted optional atom fields, not to base values', () => {
    const sparse: DnsConfigAtomValue = {
      enabled: true,
      upstreamResolvers: ['1.1.1.1'],
      ttlSeconds: 60,
      cacheSize: 4096,
      ownedDomain: 'lan',
      hostnames: ['bridge-1'],
    };
    const base = makeBase({
      upstreamTimeoutMs: 42,
      pollMs: 43,
      tcpMaxConnections: 7,
      tcpMaxQueriesPerConn: 8,
      tcpIdleTimeoutMs: 9,
      tcpMaxMessageBytes: 10,
    });
    const result = atomToDnsConfig(sparse, base);
    expect(result.upstreamTimeoutMs).toBe(DEFAULT_UPSTREAM_TIMEOUT_MS);
    expect(result.pollMs).toBe(DEFAULT_POLL_MS);
    expect(result.tcpMaxConnections).toBe(DEFAULT_TCP_MAX_CONNECTIONS);
    expect(result.tcpMaxQueriesPerConn).toBe(DEFAULT_TCP_MAX_QUERIES_PER_CONN);
    expect(result.tcpIdleTimeoutMs).toBe(DEFAULT_TCP_IDLE_TIMEOUT_MS);
    expect(result.tcpMaxMessageBytes).toBe(DEFAULT_TCP_MAX_MESSAGE_BYTES);
  });

  it('falls back to base for omitted clamp fields', () => {
    const sparse: DnsConfigAtomValue = {
      enabled: true,
      upstreamResolvers: ['1.1.1.1'],
      ttlSeconds: 60,
      cacheSize: 4096,
      ownedDomain: 'lan',
      hostnames: ['bridge-1'],
    };
    const base = makeBase({
      maxTtlSeconds: 11,
      maxCacheTtlSeconds: 12,
      minCacheTtlSeconds: 13,
      negTtlSeconds: 14,
    });
    const result = atomToDnsConfig(sparse, base);
    expect(result.maxTtlSeconds).toBe(11);
    expect(result.maxCacheTtlSeconds).toBe(12);
    expect(result.minCacheTtlSeconds).toBe(13);
    expect(result.negTtlSeconds).toBe(14);
  });

  it('self-discovers upstreams when the atom list is empty', () => {
    const result = atomToDnsConfig({ ...ZONE, upstreamResolvers: [] }, BASE, () => ['192.0.2.1']);
    expect(result.upstreamResolvers).toEqual(['192.0.2.1']);
  });

  it('falls back to the well-known public resolvers when discovery yields nothing', () => {
    const result = atomToDnsConfig({ ...ZONE, upstreamResolvers: [] }, BASE, () => []);
    expect(result.upstreamResolvers).toEqual(['1.1.1.1', '8.8.8.8']);
  });

  it('prefers atom-carried resolvers over self-discovery', () => {
    const discover = vi.fn(() => ['192.0.2.1']);
    const result = atomToDnsConfig({ ...ZONE, upstreamResolvers: ['9.9.9.9'] }, BASE, discover);
    expect(result.upstreamResolvers).toEqual(['9.9.9.9']);
    expect(discover).not.toHaveBeenCalled();
  });
});

describe('dnsConfigChanged', () => {
  it('returns false for identical configs', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig(ZONE, BASE);
    expect(dnsConfigChanged(a, b)).toBe(false);
  });

  it('detects enabled change', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig({ ...ZONE, enabled: false }, BASE);
    expect(dnsConfigChanged(a, b)).toBe(true);
  });

  it('detects ttlSeconds change', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig({ ...ZONE, ttlSeconds: 120 }, BASE);
    expect(dnsConfigChanged(a, b)).toBe(true);
  });

  it('detects upstream resolver change', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig({ ...ZONE, upstreamResolvers: ['9.9.9.9'] }, BASE);
    expect(dnsConfigChanged(a, b)).toBe(true);
  });

  it('detects upstream resolver length change', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig({ ...ZONE, upstreamResolvers: ['1.1.1.1'] }, BASE);
    expect(dnsConfigChanged(a, b)).toBe(true);
  });

  it('detects cacheSize change', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig({ ...ZONE, cacheSize: 0 }, BASE);
    expect(dnsConfigChanged(a, b)).toBe(true);
  });

  it('detects ownedDomain change', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig({ ...ZONE, ownedDomain: 'internal' }, BASE);
    expect(dnsConfigChanged(a, b)).toBe(true);
  });

  it('detects upstreamTimeoutMs change', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig({ ...ZONE, upstreamTimeoutMs: 9999 }, BASE);
    expect(dnsConfigChanged(a, b)).toBe(true);
  });

  it('detects pollMs change', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig({ ...ZONE, pollMs: 9999 }, BASE);
    expect(dnsConfigChanged(a, b)).toBe(true);
  });

  it('detects hostnames value change via atom', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig({ ...ZONE, hostnames: ['bridge-2'] }, BASE);
    expect(dnsConfigChanged(a, b)).toBe(true);
  });

  it('detects hostnames change via base identity', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig(ZONE, makeBase({ hostnames: ['bridge-01', 'bridge-02'] }));
    expect(dnsConfigChanged(a, b)).toBe(true);
  });

  it('ignores the base hostname (identity is not runtime behavior)', () => {
    const a = atomToDnsConfig(ZONE, BASE);
    const b = atomToDnsConfig(ZONE, makeBase({ hostname: 'other' }));
    expect(dnsConfigChanged(a, b)).toBe(false);
  });
});

describe('mergePrefixOverrides', () => {
  const BASE_CONFIG: DnsConfig = makeBase({
    enabled: true,
    upstreamResolvers: ['1.1.1.1', '8.8.8.8'],
  });

  it('applies the first non-empty upstreamOverride sorted by prefix id', () => {
    const overrides = new Map<string, DnsPrefixOverrideAtomValue>([
      ['zzz-prefix', { serveDns: true, upstreamOverride: ['9.9.9.9'] }],
      ['aaa-prefix', { serveDns: true, upstreamOverride: ['10.0.1.1'] }],
    ]);
    const result = mergePrefixOverrides(BASE_CONFIG, overrides);
    expect(result.upstreamResolvers).toEqual(['10.0.1.1']);
  });

  it('skips overrides with null upstreamOverride', () => {
    const overrides = new Map<string, DnsPrefixOverrideAtomValue>([
      ['aaa', { serveDns: true, upstreamOverride: null }],
      ['bbb', { serveDns: true, upstreamOverride: ['10.0.2.1'] }],
    ]);
    const result = mergePrefixOverrides(BASE_CONFIG, overrides);
    expect(result.upstreamResolvers).toEqual(['10.0.2.1']);
  });

  it('ignores upstreams from a force-off override', () => {
    const overrides = new Map<string, DnsPrefixOverrideAtomValue>([
      ['aaa', { serveDns: false, upstreamOverride: ['10.0.2.1'] }],
      ['bbb', { serveDns: null, upstreamOverride: ['10.0.9.9'] }],
    ]);
    const result = mergePrefixOverrides(BASE_CONFIG, overrides);
    expect(result.upstreamResolvers).toEqual(['10.0.9.9']);
  });

  it('skips overrides with empty upstreamOverride array', () => {
    const overrides = new Map<string, DnsPrefixOverrideAtomValue>([
      ['aaa', { serveDns: true, upstreamOverride: [] }],
      ['bbb', { serveDns: null, upstreamOverride: ['10.0.3.1'] }],
    ]);
    const result = mergePrefixOverrides(BASE_CONFIG, overrides);
    expect(result.upstreamResolvers).toEqual(['10.0.3.1']);
  });

  it('returns the same reference when no overrides apply', () => {
    const overrides = new Map<string, DnsPrefixOverrideAtomValue>([
      ['aaa', { serveDns: true, upstreamOverride: null }],
      ['bbb', { serveDns: false, upstreamOverride: [] }],
    ]);
    const result = mergePrefixOverrides(BASE_CONFIG, overrides);
    expect(result).toBe(BASE_CONFIG);
  });

  it('returns the same reference for an empty overrides map', () => {
    const result = mergePrefixOverrides(BASE_CONFIG, new Map());
    expect(result).toBe(BASE_CONFIG);
  });
});
