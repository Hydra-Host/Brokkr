import { describe, expect, it } from 'vitest';
import { DhcpAtomSchema, type DhcpAtom } from '../dhcp-atom.schema';

const VALID_ATOM: DhcpAtom = {
  mode: 'AUTHORITATIVE',
  subnet: '10.0.1.0/24',
  pools: [{ start: '10.0.1.100', end: '10.0.1.200' }],
  routers: ['10.0.1.1'],
  dnsServers: ['8.8.8.8', '8.8.4.4'],
  leaseTtlSeconds: 3600,
  reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.1.50' }],
  proxyAllowedMacs: [],
  proxyPeerAuthoritative: false,
  dhcpOptions: [{ code: 43, value: '0a:0b:0c' }],
  nextServer: '10.0.1.1',
  ipxeBuildTarget: 'IPXE',
  relay: null,
};

describe('DhcpAtomSchema', () => {
  it('accepts a fully populated valid atom', () => {
    const result = DhcpAtomSchema.safeParse(VALID_ATOM);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(VALID_ATOM);
    }
  });

  it('round-trips through JSON serialization', () => {
    const json = JSON.stringify(VALID_ATOM);
    const parsed = DhcpAtomSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(VALID_ATOM);
  });

  it('accepts all mode variants', () => {
    for (const mode of ['AUTHORITATIVE', 'PROXY', 'OFF'] as const) {
      const atom = { ...VALID_ATOM, mode };
      expect(DhcpAtomSchema.safeParse(atom).success).toBe(true);
    }
  });

  it('accepts nullable fields as null', () => {
    const atom: DhcpAtom = {
      ...VALID_ATOM,
      nextServer: null,
      ipxeBuildTarget: null,
      relay: null,
    };
    expect(DhcpAtomSchema.safeParse(atom).success).toBe(true);
  });

  it('accepts relay when populated', () => {
    const atom: DhcpAtom = {
      ...VALID_ATOM,
      relay: { relayAgentIp: '10.0.1.254' },
    };
    const result = DhcpAtomSchema.safeParse(atom);
    expect(result.success).toBe(true);
  });

  it('accepts empty arrays for pools, routers, dnsServers, reservations, dhcpOptions', () => {
    const atom: DhcpAtom = {
      ...VALID_ATOM,
      pools: [],
      routers: [],
      dnsServers: [],
      reservations: [],
      dhcpOptions: [],
    };
    expect(DhcpAtomSchema.safeParse(atom).success).toBe(true);
  });

  it('accepts all ipxeBuildTarget variants', () => {
    for (const target of ['IPXE', 'SNP', 'SNPONLY'] as const) {
      const atom = { ...VALID_ATOM, ipxeBuildTarget: target };
      expect(DhcpAtomSchema.safeParse(atom).success).toBe(true);
    }
  });

  it('rejects an invalid mode', () => {
    const atom = { ...VALID_ATOM, mode: 'INVALID' };
    expect(DhcpAtomSchema.safeParse(atom).success).toBe(false);
  });

  it('rejects an invalid subnet CIDR', () => {
    const atom = { ...VALID_ATOM, subnet: 'not-a-cidr' };
    expect(DhcpAtomSchema.safeParse(atom).success).toBe(false);
  });

  it('rejects an invalid IP in pools', () => {
    const atom = { ...VALID_ATOM, pools: [{ start: 'bad', end: '10.0.1.200' }] };
    expect(DhcpAtomSchema.safeParse(atom).success).toBe(false);
  });

  it('accepts any string value in dhcpOptions (grammar-encoded)', () => {
    const atom = { ...VALID_ATOM, dhcpOptions: [{ code: 43, value: '10.0.1.1' }] };
    expect(DhcpAtomSchema.safeParse(atom).success).toBe(true);
  });

  it('rejects dhcpOptions code outside 1..254', () => {
    expect(DhcpAtomSchema.safeParse({ ...VALID_ATOM, dhcpOptions: [{ code: 0, value: '00' }] }).success).toBe(false);
    expect(DhcpAtomSchema.safeParse({ ...VALID_ATOM, dhcpOptions: [{ code: 255, value: '00' }] }).success).toBe(false);
  });

  it('rejects zero or negative leaseTtlSeconds', () => {
    expect(DhcpAtomSchema.safeParse({ ...VALID_ATOM, leaseTtlSeconds: 0 }).success).toBe(false);
    expect(DhcpAtomSchema.safeParse({ ...VALID_ATOM, leaseTtlSeconds: -1 }).success).toBe(false);
  });

  it('rejects non-integer leaseTtlSeconds', () => {
    expect(DhcpAtomSchema.safeParse({ ...VALID_ATOM, leaseTtlSeconds: 3.5 }).success).toBe(false);
  });

  it('rejects extra fields (strict mode)', () => {
    const atom = { ...VALID_ATOM, extraField: 'bad' };
    expect(DhcpAtomSchema.safeParse(atom).success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const { mode: _mode, ...rest } = VALID_ATOM;
    expect(DhcpAtomSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects an empty mac in reservations', () => {
    const atom = { ...VALID_ATOM, reservations: [{ mac: '', ip: '10.0.1.50' }] };
    expect(DhcpAtomSchema.safeParse(atom).success).toBe(false);
  });

  it('rejects an invalid relay IP', () => {
    const atom = { ...VALID_ATOM, relay: { relayAgentIp: 'not-an-ip' } };
    expect(DhcpAtomSchema.safeParse(atom).success).toBe(false);
  });

  it('rejects non-routable IPv4 values as relay agent IPs', () => {
    for (const relayAgentIp of [
      '0.0.0.0',
      '127.0.0.1',
      '169.254.1.1',
      '224.0.0.1',
      '239.255.255.255',
      '240.1.2.3',
      '254.255.255.254',
      '255.255.255.255',
    ]) {
      expect(DhcpAtomSchema.safeParse({ ...VALID_ATOM, relay: { relayAgentIp } }).success).toBe(false);
    }
  });

  it('accepts per-reservation ipxeBuildTarget as null or a valid enum value', () => {
    for (const target of [null, 'IPXE', 'SNP', 'SNPONLY'] as const) {
      const atom = {
        ...VALID_ATOM,
        reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.1.50', ipxeBuildTarget: target }],
      };
      expect(DhcpAtomSchema.safeParse(atom).success).toBe(true);
    }
  });

  it('rejects an invalid per-reservation ipxeBuildTarget', () => {
    const atom = {
      ...VALID_ATOM,
      reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.1.50', ipxeBuildTarget: 'BIOS' }],
    };
    expect(DhcpAtomSchema.safeParse(atom).success).toBe(false);
  });
});
