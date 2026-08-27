import { describe, expect, it } from 'vitest';
import {
  DnsConfigAtomValueSchema,
  DnsPrefixOverrideAtomValueSchema,
} from '../../../../../bridge/src/dns/dns-atom-value.schema';
import { DnsConfigAtomSchema, DnsPrefixOverrideAtomSchema } from '../dns-atom.schema';

const ZONE_CONFIG_FIXTURES = [
  {
    name: 'fully populated with all optional fields',
    input: {
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
    },
  },
  {
    name: 'disabled minimal config (optional tuning absent)',
    input: {
      enabled: false,
      upstreamResolvers: [],
      ttlSeconds: 0,
      cacheSize: 0,
      ownedDomain: 'local',
      hostnames: [],
      tcpEnabled: true,
    },
  },
  {
    name: 'enabled with single resolver',
    input: {
      enabled: true,
      upstreamResolvers: ['10.0.0.1'],
      ttlSeconds: 300,
      cacheSize: 5000,
      ownedDomain: 'brokkr.internal',
      hostnames: ['bridge-a'],
      tcpEnabled: true,
    },
  },
  {
    name: 'max TTL boundary values',
    input: {
      enabled: true,
      upstreamResolvers: ['10.0.0.1'],
      ttlSeconds: 0x7fffffff,
      cacheSize: 999999,
      ownedDomain: 'edge.corp',
      hostnames: ['bridge-x', 'bridge-y', 'bridge-z'],
      upstreamTimeoutMs: 1,
      pollMs: 1,
      tcpEnabled: true,
      tcpMaxConnections: 500,
      tcpMaxQueriesPerConn: 1000,
      tcpIdleTimeoutMs: 60000,
      tcpMaxMessageBytes: 65535,
      maxTtlSeconds: 0x7fffffff,
      maxCacheTtlSeconds: 0x7fffffff,
      minCacheTtlSeconds: 0,
      negTtlSeconds: 0x7fffffff,
    },
  },
];

const PREFIX_OVERRIDE_FIXTURES = [
  {
    name: 'serving with upstream override',
    input: {
      serveDns: true,
      upstreamOverride: ['10.0.1.1', '10.0.1.2'],
      cidr: '10.0.1.0/24',
    },
  },
  {
    name: 'inherit zone defaults (all null)',
    input: {
      serveDns: null,
      upstreamOverride: null,
      cidr: '10.0.2.0/24',
    },
  },
  {
    name: 'disabled on prefix with null upstream',
    input: {
      serveDns: false,
      upstreamOverride: null,
      cidr: '172.16.8.0/22',
    },
  },
];

describe('DNS config atom schema agreement (hub + bridge)', () => {
  for (const fixture of ZONE_CONFIG_FIXTURES) {
    it(`both schemas parse "${fixture.name}" identically`, () => {
      const hubResult = DnsConfigAtomSchema.safeParse(fixture.input);
      const bridgeResult = DnsConfigAtomValueSchema.safeParse(fixture.input);

      expect(hubResult.success).toBe(true);
      expect(bridgeResult.success).toBe(true);

      if (hubResult.success && bridgeResult.success) {
        expect(hubResult.data).toEqual(bridgeResult.data);
      }
    });
  }

  it('hub and bridge schemas have the same top-level field names', () => {
    const hubKeys = Object.keys(DnsConfigAtomSchema.shape).sort();
    const bridgeKeys = Object.keys(DnsConfigAtomValueSchema.shape).sort();
    expect(hubKeys).toEqual(bridgeKeys);
  });

  it('hub always emits tcpEnabled: true while the bridge tolerates the legacy boolean', () => {
    const input = { ...ZONE_CONFIG_FIXTURES[0].input, tcpEnabled: false };
    expect(DnsConfigAtomSchema.safeParse(input).success).toBe(false);
    expect(DnsConfigAtomValueSchema.safeParse(input).success).toBe(true);
  });

  it('hub requires tcpEnabled while the bridge tolerates its absence', () => {
    const { tcpEnabled: _, ...withoutTcpEnabled } = ZONE_CONFIG_FIXTURES[0].input;
    expect(DnsConfigAtomSchema.safeParse(withoutTcpEnabled).success).toBe(false);
    expect(DnsConfigAtomValueSchema.safeParse(withoutTcpEnabled).success).toBe(true);
  });

  it('hub schema rejects extra properties (strict mode)', () => {
    const input = { ...ZONE_CONFIG_FIXTURES[0].input, bogus: true };
    const hubResult = DnsConfigAtomSchema.safeParse(input);
    expect(hubResult.success).toBe(false);
  });

  it('bridge schema allows extra properties (top-level lax for rolling upgrades)', () => {
    const input = { ...ZONE_CONFIG_FIXTURES[0].input, bogus: true };
    const bridgeResult = DnsConfigAtomValueSchema.safeParse(input);
    expect(bridgeResult.success).toBe(true);
  });
});

describe('DNS prefix-override atom schema agreement (hub + bridge)', () => {
  for (const fixture of PREFIX_OVERRIDE_FIXTURES) {
    it(`both schemas parse "${fixture.name}" identically`, () => {
      const hubResult = DnsPrefixOverrideAtomSchema.safeParse(fixture.input);
      const bridgeResult = DnsPrefixOverrideAtomValueSchema.safeParse(fixture.input);

      expect(hubResult.success).toBe(true);
      expect(bridgeResult.success).toBe(true);

      if (hubResult.success && bridgeResult.success) {
        expect(hubResult.data).toEqual(bridgeResult.data);
      }
    });
  }

  it('hub and bridge schemas have the same top-level field names', () => {
    const hubKeys = Object.keys(DnsPrefixOverrideAtomSchema.shape).sort();
    const bridgeKeys = Object.keys(DnsPrefixOverrideAtomValueSchema.shape).sort();
    expect(hubKeys).toEqual(bridgeKeys);
  });

  it('hub schema rejects extra properties (strict mode)', () => {
    const input = { ...PREFIX_OVERRIDE_FIXTURES[0].input, bogus: true };
    const hubResult = DnsPrefixOverrideAtomSchema.safeParse(input);
    expect(hubResult.success).toBe(false);
  });

  it('bridge schema allows extra properties (top-level lax for rolling upgrades)', () => {
    const input = { ...PREFIX_OVERRIDE_FIXTURES[0].input, bogus: true };
    const bridgeResult = DnsPrefixOverrideAtomValueSchema.safeParse(input);
    expect(bridgeResult.success).toBe(true);
  });

  it('hub always writes cidr; bridge tolerates its absence (atoms from an older hub)', () => {
    const withoutCidr = { serveDns: true, upstreamOverride: ['10.0.1.1', '10.0.1.2'] };
    expect(DnsPrefixOverrideAtomSchema.safeParse(withoutCidr).success).toBe(false);
    expect(DnsPrefixOverrideAtomValueSchema.safeParse(withoutCidr).success).toBe(true);
  });

  it('both schemas reject a non-IPv4 cidr', () => {
    for (const cidr of ['not-a-cidr', '10.0.0.0', '10.0.0.0/33', '2001:db8::/64']) {
      const input = { ...PREFIX_OVERRIDE_FIXTURES[0].input, cidr };
      expect(DnsPrefixOverrideAtomSchema.safeParse(input).success).toBe(false);
      expect(DnsPrefixOverrideAtomValueSchema.safeParse(input).success).toBe(false);
    }
  });
});
