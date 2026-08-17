import { describe, expect, it } from 'vitest';
import { PrefixDnsOverrideSchema, ZoneDnsConfigSchema } from '../dns';

const validZoneConfig = {
  enabled: true,
  upstreamResolvers: ['8.8.8.8', '1.1.1.1'],
  ttlSeconds: 300,
  cacheSize: 10000,
  ownedDomain: 'lan',
  upstreamTimeoutMs: 1000,
  pollMs: 2000,
  tcpMaxConnections: null,
  tcpMaxQueriesPerConn: null,
  tcpIdleTimeoutMs: null,
  tcpMaxMessageBytes: null,
  maxTtlSeconds: null,
  maxCacheTtlSeconds: null,
  minCacheTtlSeconds: null,
  negTtlSeconds: null,
};

describe('ZoneDnsConfigSchema', () => {
  it('accepts valid IPv4 upstream resolvers', () => {
    const result = ZoneDnsConfigSchema.parse(validZoneConfig);
    expect(result.upstreamResolvers).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('accepts an empty upstream resolvers array', () => {
    const result = ZoneDnsConfigSchema.parse({ ...validZoneConfig, upstreamResolvers: [] });
    expect(result.upstreamResolvers).toEqual([]);
  });

  it('rejects non-IPv4 upstream resolver strings', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, upstreamResolvers: ['not-an-ip'] })).toThrow();
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, upstreamResolvers: ['example.com'] })).toThrow();
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, upstreamResolvers: [''] })).toThrow();
  });

  it('rejects IPv6 upstream resolvers', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, upstreamResolvers: ['::1'] })).toThrow();
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, upstreamResolvers: ['2001:db8::1'] })).toThrow();
  });

  it('rejects a mix of valid and invalid resolvers', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, upstreamResolvers: ['8.8.8.8', 'bad'] })).toThrow();
  });

  it('rejects empty ownedDomain', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, ownedDomain: '' })).toThrow();
  });

  it('accepts valid single-label ownedDomain', () => {
    expect(ZoneDnsConfigSchema.parse({ ...validZoneConfig, ownedDomain: 'lan' }).ownedDomain).toBe('lan');
  });

  it('accepts valid multi-label ownedDomain', () => {
    expect(ZoneDnsConfigSchema.parse({ ...validZoneConfig, ownedDomain: 'brokkr.internal' }).ownedDomain).toBe(
      'brokkr.internal',
    );
  });

  it('rejects ownedDomain with spaces', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, ownedDomain: 'my domain' })).toThrow();
  });

  it('rejects ownedDomain with leading hyphen', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, ownedDomain: '-bad' })).toThrow();
  });

  it('rejects ownedDomain with trailing hyphen', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, ownedDomain: 'bad-' })).toThrow();
  });

  it('rejects ownedDomain with special characters', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, ownedDomain: 'bad@domain' })).toThrow();
  });

  it('rejects ownedDomain exceeding 253 characters', () => {
    const tooLong = 'a'.repeat(254);
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, ownedDomain: tooLong })).toThrow();
  });

  it('accepts valid long ownedDomain under 253 characters', () => {
    const long = Array(64).fill('a').join('.');
    expect(ZoneDnsConfigSchema.parse({ ...validZoneConfig, ownedDomain: long }).ownedDomain).toBe(long);
  });

  it('rejects ownedDomain with a label exceeding 63 characters', () => {
    const badLabel = 'a'.repeat(64) + '.com';
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, ownedDomain: badLabel })).toThrow();
  });

  it('accepts ttlSeconds at the signed-32-bit max', () => {
    expect(ZoneDnsConfigSchema.parse({ ...validZoneConfig, ttlSeconds: 0x7fffffff }).ttlSeconds).toBe(0x7fffffff);
  });

  it('rejects ttlSeconds above the signed-32-bit max', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, ttlSeconds: 0x80000000 })).toThrow();
  });

  it('rejects upstreamTimeoutMs of 0', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, upstreamTimeoutMs: 0 })).toThrow();
  });

  it('rejects pollMs of 0', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, pollMs: 0 })).toThrow();
  });

  it('rejects a config missing upstreamTimeoutMs or pollMs', () => {
    const { upstreamTimeoutMs: _t, ...withoutTimeout } = validZoneConfig;
    expect(() => ZoneDnsConfigSchema.parse(withoutTimeout)).toThrow();
    const { pollMs: _p, ...withoutPoll } = validZoneConfig;
    expect(() => ZoneDnsConfigSchema.parse(withoutPoll)).toThrow();
  });

  it('rejects tcpMaxConnections of 0', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, tcpMaxConnections: 0 })).toThrow();
  });

  it('accepts tcpMaxConnections of 1', () => {
    expect(ZoneDnsConfigSchema.parse({ ...validZoneConfig, tcpMaxConnections: 1 }).tcpMaxConnections).toBe(1);
  });

  it('accepts tcpMaxConnections of null', () => {
    expect(ZoneDnsConfigSchema.parse({ ...validZoneConfig, tcpMaxConnections: null }).tcpMaxConnections).toBeNull();
  });

  it('rejects tcpMaxQueriesPerConn of 0', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, tcpMaxQueriesPerConn: 0 })).toThrow();
  });

  it('accepts tcpMaxQueriesPerConn of 1', () => {
    expect(ZoneDnsConfigSchema.parse({ ...validZoneConfig, tcpMaxQueriesPerConn: 1 }).tcpMaxQueriesPerConn).toBe(1);
  });

  it('rejects tcpIdleTimeoutMs of 0', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, tcpIdleTimeoutMs: 0 })).toThrow();
  });

  it('accepts tcpIdleTimeoutMs of 1', () => {
    expect(ZoneDnsConfigSchema.parse({ ...validZoneConfig, tcpIdleTimeoutMs: 1 }).tcpIdleTimeoutMs).toBe(1);
  });

  it('rejects tcpMaxMessageBytes of 0', () => {
    expect(() => ZoneDnsConfigSchema.parse({ ...validZoneConfig, tcpMaxMessageBytes: 0 })).toThrow();
  });

  it('accepts tcpMaxMessageBytes of 1', () => {
    expect(ZoneDnsConfigSchema.parse({ ...validZoneConfig, tcpMaxMessageBytes: 1 }).tcpMaxMessageBytes).toBe(1);
  });

  it('rejects minCacheTtlSeconds > maxCacheTtlSeconds', () => {
    expect(() =>
      ZoneDnsConfigSchema.parse({ ...validZoneConfig, minCacheTtlSeconds: 60, maxCacheTtlSeconds: 30 }),
    ).toThrow(/minCacheTtlSeconds must be <= maxCacheTtlSeconds/);
  });

  it('accepts minCacheTtlSeconds === maxCacheTtlSeconds', () => {
    const result = ZoneDnsConfigSchema.parse({ ...validZoneConfig, minCacheTtlSeconds: 60, maxCacheTtlSeconds: 60 });
    expect(result.minCacheTtlSeconds).toBe(60);
    expect(result.maxCacheTtlSeconds).toBe(60);
  });

  it('accepts minCacheTtlSeconds < maxCacheTtlSeconds', () => {
    const result = ZoneDnsConfigSchema.parse({ ...validZoneConfig, minCacheTtlSeconds: 10, maxCacheTtlSeconds: 300 });
    expect(result.minCacheTtlSeconds).toBe(10);
    expect(result.maxCacheTtlSeconds).toBe(300);
  });

  it('accepts minCacheTtlSeconds when maxCacheTtlSeconds is null', () => {
    const result = ZoneDnsConfigSchema.parse({ ...validZoneConfig, minCacheTtlSeconds: 10, maxCacheTtlSeconds: null });
    expect(result.minCacheTtlSeconds).toBe(10);
    expect(result.maxCacheTtlSeconds).toBeNull();
  });
});

const validPrefixOverride = {
  serveDns: null,
  upstreamOverride: ['1.1.1.1'],
};

describe('PrefixDnsOverrideSchema', () => {
  it('accepts valid IPv4 upstream override', () => {
    const result = PrefixDnsOverrideSchema.parse(validPrefixOverride);
    expect(result.upstreamOverride).toEqual(['1.1.1.1']);
  });

  it('accepts an empty upstream override array', () => {
    const result = PrefixDnsOverrideSchema.parse({ ...validPrefixOverride, upstreamOverride: [] });
    expect(result.upstreamOverride).toEqual([]);
  });

  it('rejects non-IPv4 upstream override strings', () => {
    expect(() => PrefixDnsOverrideSchema.parse({ ...validPrefixOverride, upstreamOverride: ['not-an-ip'] })).toThrow();
  });

  it('rejects IPv6 upstream override', () => {
    expect(() => PrefixDnsOverrideSchema.parse({ ...validPrefixOverride, upstreamOverride: ['::1'] })).toThrow();
  });
});
