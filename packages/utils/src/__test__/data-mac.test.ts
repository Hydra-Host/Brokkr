import { describe, expect, it } from 'vitest';
import { pickBmcMac, pickDataInterface, pickDataMac } from '../data-mac';

const ifaces = [
  { name: 'ipmi0', macAddress: 'aa:aa:aa:aa:aa:01', mgmtOnly: true },
  { name: 'eth0', macAddress: null, mgmtOnly: false },
  { name: 'eth1', macAddress: 'aa:aa:aa:aa:aa:02', mgmtOnly: false },
  { name: 'eth2', macAddress: 'aa:aa:aa:aa:aa:03', mgmtOnly: false },
];

describe('pickDataMac', () => {
  it('returns the first non-management interface with a MAC', () => {
    expect(pickDataMac(ifaces)?.name).toBe('eth1');
  });

  it('returns undefined when every interface is management-only or has no MAC', () => {
    expect(pickDataMac([ifaces[0]!, ifaces[1]!])).toBeUndefined();
  });
});

describe('pickBmcMac', () => {
  it('returns the first management-only interface with a MAC', () => {
    expect(pickBmcMac(ifaces)?.name).toBe('ipmi0');
  });

  it('treats a missing mgmtOnly as false', () => {
    expect(pickBmcMac([{ macAddress: 'aa:aa:aa:aa:aa:09' }])).toBeUndefined();
  });
});

const metal1 = [
  { name: 'IPMI', macAddress: '7c:c2:55:8d:09:8f', mgmtOnly: true, ipAddresses: [{ address: '172.16.28.5' }] },
  { name: 'ens257np0', macAddress: '58:a2:e1:2e:16:88', mgmtOnly: false, ipAddresses: [] },
  { name: 'ens4047f0np0', macAddress: '80:61:5f:2c:59:ac', mgmtOnly: false, ipAddresses: [{ address: '172.16.12.50' }] },
  { name: 'ens4047f1np1', macAddress: '80:61:5f:2c:59:ad', mgmtOnly: false, ipAddresses: [] },
  { name: 'mlx5_0', macAddress: null, mgmtOnly: false, ipAddresses: [] },
];

describe('pickDataInterface', () => {
  it('prefers the data interface that holds an address over an earlier one without', () => {
    expect(pickDataInterface(metal1)).toMatchObject({ iface: { name: 'ens4047f0np0' }, tier: 'address' });
  });

  it('falls back to the first data interface with a mac when none holds an address', () => {
    const unaddressed = metal1.map((i) => ({ ...i, ipAddresses: [] }));
    expect(pickDataInterface(unaddressed)).toMatchObject({ iface: { name: 'ens257np0' }, tier: 'name-order' });
  });

  it('treats rows without an ipAddresses field as unaddressed', () => {
    expect(pickDataInterface(ifaces)).toMatchObject({ iface: { name: 'eth1' }, tier: 'name-order' });
  });

  it('keeps pickDataMac on the same choice', () => {
    expect(pickDataMac(metal1)?.name).toBe('ens4047f0np0');
  });
});
