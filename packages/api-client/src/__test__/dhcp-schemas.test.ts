import { describe, expect, it } from 'vitest';
import {
  DhcpLeaseSchema,
  DhcpModeSchema,
  DhcpOptionSchema,
  IpxeBuildTargetSchema,
  PrefixDhcpConfigSchema,
  RESERVED_DHCP_OPTION_CODES,
} from '../index';

describe('DhcpModeSchema', () => {
  it('accepts valid modes', () => {
    expect(DhcpModeSchema.parse('AUTHORITATIVE')).toBe('AUTHORITATIVE');
    expect(DhcpModeSchema.parse('PROXY')).toBe('PROXY');
    expect(DhcpModeSchema.parse('OFF')).toBe('OFF');
  });

  it('rejects invalid modes', () => {
    expect(() => DhcpModeSchema.parse('DISABLED')).toThrow();
    expect(() => DhcpModeSchema.parse('')).toThrow();
  });
});

describe('IpxeBuildTargetSchema', () => {
  it('accepts valid targets', () => {
    expect(IpxeBuildTargetSchema.parse('IPXE')).toBe('IPXE');
    expect(IpxeBuildTargetSchema.parse('SNP')).toBe('SNP');
    expect(IpxeBuildTargetSchema.parse('SNPONLY')).toBe('SNPONLY');
  });

  it('rejects invalid targets', () => {
    expect(() => IpxeBuildTargetSchema.parse('UEFI')).toThrow();
  });
});

describe('DhcpOptionSchema', () => {
  it('accepts valid option', () => {
    const result = DhcpOptionSchema.parse({ code: 12, value: 'myhost' });
    expect(result.code).toBe(12);
    expect(result.value).toBe('myhost');
  });

  it('rejects code below 1', () => {
    expect(() => DhcpOptionSchema.parse({ code: 0, value: 'x' })).toThrow();
  });

  it('rejects code above 254', () => {
    expect(() => DhcpOptionSchema.parse({ code: 255, value: 'x' })).toThrow();
  });

  it('rejects empty value', () => {
    expect(() => DhcpOptionSchema.parse({ code: 12, value: '' })).toThrow();
  });

  it('accepts a value at the 255-char boundary', () => {
    expect(DhcpOptionSchema.parse({ code: 12, value: 'x'.repeat(255) }).value).toHaveLength(255);
  });

  it('rejects a value over 255 chars (would overflow the 255-byte option payload)', () => {
    expect(() => DhcpOptionSchema.parse({ code: 12, value: 'x'.repeat(256) })).toThrow();
  });

  it('rejects non-integer code', () => {
    expect(() => DhcpOptionSchema.parse({ code: 1.5, value: 'x' })).toThrow();
  });
});

describe('PrefixDhcpConfigSchema', () => {
  const validConfig = {
    dhcpMode: 'AUTHORITATIVE',
    dhcpLeaseTtlSeconds: 3600,
    ipxeBuildTarget: 'IPXE',
    dhcpOptions: [{ code: 12, value: 'myhost' }],
    dhcpProxyAllowedMacs: [],
    dhcpProxyPeerAuthoritative: false,
    dhcpRelayAgentIp: null,
  };

  it('accepts a valid config', () => {
    const result = PrefixDhcpConfigSchema.parse(validConfig);
    expect(result.dhcpMode).toBe('AUTHORITATIVE');
  });

  it('silently strips the removed dhcpNextServer/dhcpDnsServers fields (does not reject)', () => {
    const result = PrefixDhcpConfigSchema.parse({
      ...validConfig,
      dhcpNextServer: '10.0.0.1',
      dhcpDnsServers: ['10.0.0.2'],
    });
    expect(result).not.toHaveProperty('dhcpNextServer');
    expect(result).not.toHaveProperty('dhcpDnsServers');
  });

  it('accepts a disabled config (null dhcpMode) with the materialized ipxe default', () => {
    const result = PrefixDhcpConfigSchema.parse({
      dhcpMode: null,
      dhcpLeaseTtlSeconds: null,
      ipxeBuildTarget: 'IPXE',
      dhcpOptions: [],
      dhcpProxyAllowedMacs: [],
      dhcpProxyPeerAuthoritative: false,
      dhcpRelayAgentIp: null,
    });
    expect(result.dhcpMode).toBeNull();
  });

  it('rejects more than 32 custom dhcpOptions', () => {
    const many = Array.from({ length: 33 }, (_, i) => ({ code: 100 + i, value: 'x' }));
    expect(() => PrefixDhcpConfigSchema.parse({ ...validConfig, dhcpOptions: many })).toThrow();
    const ok = Array.from({ length: 32 }, (_, i) => ({ code: 100 + i, value: 'x' }));
    expect(PrefixDhcpConfigSchema.parse({ ...validConfig, dhcpOptions: ok }).dhcpOptions).toHaveLength(32);
  });

  it('rejects duplicate dhcpOption codes (server rejects them too — enforce at parse)', () => {
    expect(() =>
      PrefixDhcpConfigSchema.parse({
        ...validConfig,
        dhcpOptions: [
          { code: 12, value: 'a' },
          { code: 12, value: 'b' },
        ],
      }),
    ).toThrow();
  });

  it('rejects lease TTL below minimum (120)', () => {
    expect(() =>
      PrefixDhcpConfigSchema.parse({
        ...validConfig,
        dhcpLeaseTtlSeconds: 10,
      }),
    ).toThrow();
  });

  it('accepts lease TTL at minimum boundary (120)', () => {
    const result = PrefixDhcpConfigSchema.parse({
      ...validConfig,
      dhcpLeaseTtlSeconds: 120,
    });
    expect(result.dhcpLeaseTtlSeconds).toBe(120);
  });

  it('accepts lease TTL at maximum boundary (INT32 max, 0x7fffffff)', () => {
    const result = PrefixDhcpConfigSchema.parse({
      ...validConfig,
      dhcpLeaseTtlSeconds: 0x7fffffff,
    });
    expect(result.dhcpLeaseTtlSeconds).toBe(0x7fffffff);
  });

  it('rejects lease TTL above INT32 max (would overflow the PostgreSQL INTEGER column)', () => {
    for (const ttl of [0x7fffffff + 1, 0xffffffff]) {
      expect(() => PrefixDhcpConfigSchema.parse({ ...validConfig, dhcpLeaseTtlSeconds: ttl })).toThrow();
    }
  });

  it('accepts a valid DHCP relay agent IPv4 address', () => {
    const result = PrefixDhcpConfigSchema.parse({ ...validConfig, dhcpRelayAgentIp: '10.0.1.254' });
    expect(result.dhcpRelayAgentIp).toBe('10.0.1.254');
  });

  it('rejects an invalid DHCP relay agent IP address', () => {
    expect(() => PrefixDhcpConfigSchema.parse({ ...validConfig, dhcpRelayAgentIp: '2001:db8::1' })).toThrow();
    expect(() => PrefixDhcpConfigSchema.parse({ ...validConfig, dhcpRelayAgentIp: '10.0.1.999' })).toThrow();
  });

  it('rejects non-routable IPv4 values as relay agent IPs', () => {
    for (const dhcpRelayAgentIp of [
      '0.0.0.0',
      '127.0.0.1',
      '169.254.1.1',
      '224.0.0.1',
      '239.255.255.255',
      '255.255.255.255',
    ]) {
      expect(() => PrefixDhcpConfigSchema.parse({ ...validConfig, dhcpRelayAgentIp })).toThrow();
    }
  });

  it('requires dhcpRelayAgentIp in the full-replace config', () => {
    expect(() =>
      PrefixDhcpConfigSchema.parse({
        dhcpMode: 'AUTHORITATIVE',
        dhcpLeaseTtlSeconds: 3600,
        ipxeBuildTarget: 'IPXE',
        dhcpOptions: [],
        dhcpProxyAllowedMacs: [],
      }),
    ).toThrow();
  });
});

describe('RESERVED_DHCP_OPTION_CODES', () => {
  it('includes the well-known reserved codes', () => {
    expect(RESERVED_DHCP_OPTION_CODES.has(1)).toBe(true);
    expect(RESERVED_DHCP_OPTION_CODES.has(51)).toBe(true);
    expect(RESERVED_DHCP_OPTION_CODES.has(54)).toBe(true);
    expect(RESERVED_DHCP_OPTION_CODES.has(67)).toBe(true);
  });

  it('does not include non-reserved codes', () => {
    expect(RESERVED_DHCP_OPTION_CODES.has(12)).toBe(false);
    expect(RESERVED_DHCP_OPTION_CODES.has(150)).toBe(false);
  });

  it('reserves every code the hub/bridge auto-manages, so an operator override cannot fight them', () => {
    for (const code of [1, 3, 6, 28, 43, 50, 51, 52, 53, 54, 55, 57, 58, 59, 60, 66, 67]) {
      expect(RESERVED_DHCP_OPTION_CODES.has(code), `code ${code} must be reserved`).toBe(true);
    }
  });
});

describe('DhcpLeaseSchema', () => {
  const validLease = {
    ip: '10.0.1.50',
    mac: 'aa:bb:cc:dd:ee:ff',
    hostname: 'myhost',
    expiresAt: 1750000000,
  };

  it('accepts a valid lease', () => {
    const result = DhcpLeaseSchema.parse(validLease);
    expect(result.ip).toBe('10.0.1.50');
    expect(result.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(result.hostname).toBe('myhost');
    expect(result.expiresAt).toBe(1750000000);
  });

  it('rejects an invalid IP address', () => {
    expect(() => DhcpLeaseSchema.parse({ ...validLease, ip: '999.0.0.1' })).toThrow();
  });

  it('rejects a non-integer expiresAt', () => {
    expect(() => DhcpLeaseSchema.parse({ ...validLease, expiresAt: 1.5 })).toThrow();
  });

  it('rejects a negative expiresAt', () => {
    expect(() => DhcpLeaseSchema.parse({ ...validLease, expiresAt: -1 })).toThrow();
  });

  it('rejects an uppercase / non-colon-hex mac', () => {
    expect(() => DhcpLeaseSchema.parse({ ...validLease, mac: 'AA:BB:CC:DD:EE:FF' })).toThrow();
    expect(() => DhcpLeaseSchema.parse({ ...validLease, mac: 'aabbccddeeff' })).toThrow();
  });

  it('accepts null hostname', () => {
    const result = DhcpLeaseSchema.parse({ ...validLease, hostname: null });
    expect(result.hostname).toBeNull();
  });

  it('rejects missing required fields', () => {
    expect(() => DhcpLeaseSchema.parse({ ip: '10.0.1.50' })).toThrow();
    expect(() => DhcpLeaseSchema.parse({})).toThrow();
  });
});
