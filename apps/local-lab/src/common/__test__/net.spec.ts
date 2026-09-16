import { describe, expect, it, vi } from 'vitest';

import { isIpv4Family, resolveIfaceCidr, resolveIfaceIp } from '../net';

const { nics } = vi.hoisted(() => ({
  nics: {
    lo: [{ family: 'IPv4', address: '127.0.0.1', cidr: '127.0.0.1/8', internal: true }],
    eth0: [
      { family: 'IPv6', address: 'fe80::1', cidr: 'fe80::1/64', internal: false },
      { family: 'IPv4', address: '192.168.1.42', cidr: '192.168.1.42/24', internal: false },
    ],
    tun0: [{ family: 'IPv4', address: '10.8.0.2', cidr: null, internal: false }],
  },
}));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, networkInterfaces: () => nics };
});

describe('isIpv4Family', () => {
  it('accepts the Node 24 / @types/node string form', () => {
    expect(isIpv4Family('IPv4')).toBe(true);
  });
  it('accepts the legacy numeric form (pre-Node-18 os.networkInterfaces)', () => {
    expect(isIpv4Family(4)).toBe(true);
  });
  it('rejects IPv6 in both forms', () => {
    expect(isIpv4Family('IPv6')).toBe(false);
    expect(isIpv4Family(6)).toBe(false);
  });
});

describe('resolveIfaceCidr', () => {
  it('returns ip and cidr for an external ipv4 entry', () => {
    expect(resolveIfaceCidr('eth0')).toEqual({ ip: '192.168.1.42', cidr: '192.168.1.42/24' });
  });

  it('returns a null cidr when the interface reports none', () => {
    expect(resolveIfaceCidr('tun0')).toEqual({ ip: '10.8.0.2', cidr: null });
  });

  it('returns null for an unknown or empty interface name', () => {
    expect(resolveIfaceCidr('')).toBeNull();
    expect(resolveIfaceCidr('nope0')).toBeNull();
  });

  it('skips internal entries', () => {
    expect(resolveIfaceCidr('lo')).toBeNull();
  });

  it('resolveIfaceIp stays the ip of resolveIfaceCidr', () => {
    expect(resolveIfaceIp('eth0')).toBe('192.168.1.42');
    expect(resolveIfaceIp('tun0')).toBe('10.8.0.2');
    expect(resolveIfaceIp('nope0')).toBe('');
    expect(resolveIfaceIp('')).toBe('');
  });
});
