import { describe, expect, it } from 'vitest';

import {
  DnsConfigAtomValueSchema,
  DnsPrefixOverrideAtomValueSchema,
  type DnsConfigAtomValue,
  type DnsPrefixOverrideAtomValue,
} from '../dns-atom-value.schema';

const VALID_ZONE_CONFIG: DnsConfigAtomValue = {
  enabled: true,
  upstreamResolvers: ['1.1.1.1', '8.8.8.8'],
  ttlSeconds: 60,
  cacheSize: 10000,
  ownedDomain: 'lan',
  hostnames: ['bridge-1', 'bridge-2'],
  upstreamTimeoutMs: 1500,
  pollMs: 2500,
  tcpEnabled: true,
  tcpMaxConnections: 20,
  tcpMaxQueriesPerConn: 100,
  tcpIdleTimeoutMs: 5000,
  tcpMaxMessageBytes: 4096,
  maxTtlSeconds: 86400,
  maxCacheTtlSeconds: 3600,
  minCacheTtlSeconds: 30,
  negTtlSeconds: 300,
};

const VALID_PREFIX_OVERRIDE: DnsPrefixOverrideAtomValue = {
  serveDns: true,
  upstreamOverride: ['10.0.1.1'],
  cidr: '10.0.1.0/24',
};

describe('DnsConfigAtomValueSchema (bridge)', () => {
  it('accepts a fully populated valid value', () => {
    const result = DnsConfigAtomValueSchema.safeParse(VALID_ZONE_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(VALID_ZONE_CONFIG);
    }
  });

  it('round-trips through JSON serialization', () => {
    const json = JSON.stringify(VALID_ZONE_CONFIG);
    const parsed = DnsConfigAtomValueSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(VALID_ZONE_CONFIG);
  });

  it('accepts config with only required fields (all optional fields absent)', () => {
    const minimal: DnsConfigAtomValue = {
      enabled: false,
      upstreamResolvers: [],
      ttlSeconds: 0,
      cacheSize: 0,
      ownedDomain: 'local',
      hostnames: [],
    };
    expect(DnsConfigAtomValueSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts an atom without tcpEnabled (newer hubs may drop it)', () => {
    const { tcpEnabled: _, ...withoutTcpEnabled } = VALID_ZONE_CONFIG;
    expect(DnsConfigAtomValueSchema.safeParse(withoutTcpEnabled).success).toBe(true);
  });

  it('still parses (and ignores) a boolean tcpEnabled from an older hub', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, tcpEnabled: false }).success).toBe(true);
  });

  it('parses upstreamTimeoutMs and pollMs', () => {
    const result = DnsConfigAtomValueSchema.safeParse(VALID_ZONE_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.upstreamTimeoutMs).toBe(1500);
      expect(result.data.pollMs).toBe(2500);
    }
  });

  it('rejects non-positive upstreamTimeoutMs', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, upstreamTimeoutMs: 0 }).success).toBe(false);
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, upstreamTimeoutMs: -1 }).success).toBe(false);
  });

  it('rejects non-positive pollMs', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, pollMs: 0 }).success).toBe(false);
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, pollMs: -1 }).success).toBe(false);
  });

  it('rejects non-integer upstreamTimeoutMs and pollMs', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, upstreamTimeoutMs: 1.5 }).success).toBe(false);
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, pollMs: 1.5 }).success).toBe(false);
  });

  it('rejects non-boolean enabled', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, enabled: 'yes' }).success).toBe(false);
  });

  it('rejects invalid upstream resolver IP', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, upstreamResolvers: ['not-an-ip'] }).success).toBe(
      false,
    );
  });

  it('rejects negative ttlSeconds', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, ttlSeconds: -1 }).success).toBe(false);
  });

  it('rejects ttlSeconds above 0x7fffffff', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, ttlSeconds: 0x80000000 }).success).toBe(false);
  });

  it('rejects empty ownedDomain', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, ownedDomain: '' }).success).toBe(false);
  });

  it('rejects tcpMaxConnections below 1', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, tcpMaxConnections: 0 }).success).toBe(false);
  });

  it('rejects non-integer ttlSeconds', () => {
    expect(DnsConfigAtomValueSchema.safeParse({ ...VALID_ZONE_CONFIG, ttlSeconds: 1.5 }).success).toBe(false);
  });

  it('allows extra properties (no strict mode)', () => {
    const input = { ...VALID_ZONE_CONFIG, futureField: 'ignored' };
    expect(DnsConfigAtomValueSchema.safeParse(input).success).toBe(true);
  });

  it('rejects missing required fields', () => {
    const { enabled: _, ...incomplete } = VALID_ZONE_CONFIG;
    expect(DnsConfigAtomValueSchema.safeParse(incomplete).success).toBe(false);
  });
});

describe('DnsPrefixOverrideAtomValueSchema (bridge)', () => {
  it('accepts a valid prefix override', () => {
    const result = DnsPrefixOverrideAtomValueSchema.safeParse(VALID_PREFIX_OVERRIDE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(VALID_PREFIX_OVERRIDE);
    }
  });

  it('accepts all-null (inherit zone defaults)', () => {
    const value: DnsPrefixOverrideAtomValue = { serveDns: null, upstreamOverride: null };
    expect(DnsPrefixOverrideAtomValueSchema.safeParse(value).success).toBe(true);
  });

  it('accepts disabled with null upstream', () => {
    const value: DnsPrefixOverrideAtomValue = { serveDns: false, upstreamOverride: null };
    expect(DnsPrefixOverrideAtomValueSchema.safeParse(value).success).toBe(true);
  });

  it('rejects invalid upstream IP', () => {
    expect(DnsPrefixOverrideAtomValueSchema.safeParse({ serveDns: true, upstreamOverride: ['bad'] }).success).toBe(
      false,
    );
  });

  it('rejects non-boolean serveDns', () => {
    expect(DnsPrefixOverrideAtomValueSchema.safeParse({ serveDns: 'yes', upstreamOverride: null }).success).toBe(false);
  });

  it('accepts an atom without cidr (older hubs omit it)', () => {
    const { cidr: _, ...withoutCidr } = VALID_PREFIX_OVERRIDE;
    const result = DnsPrefixOverrideAtomValueSchema.safeParse(withoutCidr);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cidr).toBeUndefined();
    }
  });

  it('parses and preserves cidr when present', () => {
    const result = DnsPrefixOverrideAtomValueSchema.safeParse(VALID_PREFIX_OVERRIDE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cidr).toBe('10.0.1.0/24');
    }
  });

  it('rejects non-string cidr', () => {
    expect(DnsPrefixOverrideAtomValueSchema.safeParse({ ...VALID_PREFIX_OVERRIDE, cidr: 42 }).success).toBe(false);
  });

  it('rejects malformed and non-IPv4 cidr strings', () => {
    expect(DnsPrefixOverrideAtomValueSchema.safeParse({ ...VALID_PREFIX_OVERRIDE, cidr: 'not-a-cidr' }).success).toBe(
      false,
    );
    expect(DnsPrefixOverrideAtomValueSchema.safeParse({ ...VALID_PREFIX_OVERRIDE, cidr: '10.0.0.0' }).success).toBe(
      false,
    );
    expect(DnsPrefixOverrideAtomValueSchema.safeParse({ ...VALID_PREFIX_OVERRIDE, cidr: '10.0.0.0/33' }).success).toBe(
      false,
    );
    expect(
      DnsPrefixOverrideAtomValueSchema.safeParse({ ...VALID_PREFIX_OVERRIDE, cidr: '2001:db8::/64' }).success,
    ).toBe(false);
  });

  it('allows extra properties (no strict mode)', () => {
    const input = { ...VALID_PREFIX_OVERRIDE, futureField: true };
    expect(DnsPrefixOverrideAtomValueSchema.safeParse(input).success).toBe(true);
  });
});
