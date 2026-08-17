import { describe, expect, it } from 'vitest';

import { DhcpAtomValueSchema, type DhcpAtomValue } from '../dhcp-atom-value.schema';

const VALID_VALUE: DhcpAtomValue = {
  mode: 'AUTHORITATIVE',
  subnet: '10.0.1.0/24',
  pools: [{ start: '10.0.1.100', end: '10.0.1.200' }],
  routers: ['10.0.1.1'],
  dnsServers: ['8.8.8.8'],
  leaseTtlSeconds: 3600,
  reservations: [{ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.1.50' }],
  dhcpOptions: [{ code: 43, value: '0a:0b:0c' }],
  nextServer: '10.0.1.1',
  ipxeBuildTarget: 'IPXE',
  relay: { relayAgentIp: '10.0.1.254' },
  proxyAllowedMacs: [],
  proxyPeerAuthoritative: false,
};

describe('DhcpAtomValueSchema (bridge)', () => {
  it('accepts a fully populated valid value', () => {
    const result = DhcpAtomValueSchema.safeParse(VALID_VALUE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(VALID_VALUE);
    }
  });

  it('round-trips through JSON serialization', () => {
    const json = JSON.stringify(VALID_VALUE);
    const parsed = DhcpAtomValueSchema.parse(JSON.parse(json));
    expect(parsed).toEqual(VALID_VALUE);
  });

  it('accepts all nullable fields as null', () => {
    const value: DhcpAtomValue = {
      ...VALID_VALUE,
      nextServer: null,
      ipxeBuildTarget: null,
      relay: null,
    };
    expect(DhcpAtomValueSchema.safeParse(value).success).toBe(true);
  });

  it('rejects an invalid mode', () => {
    expect(DhcpAtomValueSchema.safeParse({ ...VALID_VALUE, mode: 'INVALID' }).success).toBe(false);
  });

  it('accepts any string value in dhcpOptions (grammar-encoded)', () => {
    expect(
      DhcpAtomValueSchema.safeParse({
        ...VALID_VALUE,
        dhcpOptions: [{ code: 43, value: '10.0.1.1' }],
      }).success,
    ).toBe(true);
  });

  it('rejects zero leaseTtlSeconds', () => {
    expect(DhcpAtomValueSchema.safeParse({ ...VALID_VALUE, leaseTtlSeconds: 0 }).success).toBe(false);
  });

  it('rejects non-routable IPv4 values as relay agent IPs', () => {
    for (const relayAgentIp of [
      '0.0.0.0',
      '127.0.0.1',
      '169.254.1.1',
      '224.0.0.1',
      '239.255.255.255',
      '255.255.255.255',
    ]) {
      expect(DhcpAtomValueSchema.safeParse({ ...VALID_VALUE, relay: { relayAgentIp } }).success).toBe(false);
    }
  });
});
