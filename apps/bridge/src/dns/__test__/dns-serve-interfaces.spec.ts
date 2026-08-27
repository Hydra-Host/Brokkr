import { describe, expect, it } from 'vitest';

import type { DnsPrefixOverrideAtomValue } from '../dns-atom-value.schema';
import { dnsServeCidrs, dnsServeInterfaceIps, unionInterfaceIps } from '../dns-serve-interfaces';

function overridesOf(entries: Array<[string, DnsPrefixOverrideAtomValue]>): Map<string, DnsPrefixOverrideAtomValue> {
  return new Map(entries);
}

const NICS = [
  { name: 'enp1s0f1np1', ip: '172.16.8.101' },
  { name: 'enp1s0f1np1', ip: '172.16.11.234' },
  { name: 'eth0', ip: '10.0.0.5' },
];

describe('dnsServeCidrs', () => {
  it('returns cidrs only for serveDns=true overrides', () => {
    const overrides = overridesOf([
      ['p-on', { serveDns: true, upstreamOverride: null, cidr: '172.16.8.0/22' }],
      ['p-off', { serveDns: false, upstreamOverride: null, cidr: '10.0.0.0/24' }],
      ['p-inherit', { serveDns: null, upstreamOverride: ['1.1.1.1'], cidr: '10.0.1.0/24' }],
    ]);
    expect(dnsServeCidrs(overrides)).toEqual(['172.16.8.0/22']);
  });

  it('skips overrides without a cidr (older hub atoms)', () => {
    const overrides = overridesOf([['p-on', { serveDns: true, upstreamOverride: null }]]);
    expect(dnsServeCidrs(overrides)).toEqual([]);
  });

  it('skips malformed and non-IPv4 cidrs', () => {
    const overrides = overridesOf([
      ['p-bad', { serveDns: true, upstreamOverride: null, cidr: 'not-a-cidr' }],
      ['p-noslash', { serveDns: true, upstreamOverride: null, cidr: '10.0.0.0' }],
      ['p-range', { serveDns: true, upstreamOverride: null, cidr: '10.0.0.0/33' }],
      ['p-v6', { serveDns: true, upstreamOverride: null, cidr: '2001:db8::/64' }],
    ]);
    expect(dnsServeCidrs(overrides)).toEqual([]);
  });

  it('deduplicates and sorts deterministically by prefix id', () => {
    const overrides = overridesOf([
      ['p-zzz', { serveDns: true, upstreamOverride: null, cidr: '10.0.2.0/24' }],
      ['p-aaa', { serveDns: true, upstreamOverride: null, cidr: '10.0.1.0/24' }],
      ['p-dup', { serveDns: true, upstreamOverride: null, cidr: '10.0.1.0/24' }],
    ]);
    expect(dnsServeCidrs(overrides)).toEqual(['10.0.1.0/24', '10.0.2.0/24']);
  });
});

describe('dnsServeInterfaceIps', () => {
  it('returns local NIC IPs contained in a serve-on cidr', () => {
    const overrides = overridesOf([['p-on', { serveDns: true, upstreamOverride: null, cidr: '172.16.8.0/22' }]]);
    expect(dnsServeInterfaceIps(overrides, () => NICS)).toEqual([
      { interface: 'enp1s0f1np1', ip: '172.16.8.101', cidr: '172.16.8.0/22' },
      { interface: 'enp1s0f1np1', ip: '172.16.11.234', cidr: '172.16.8.0/22' },
    ]);
  });

  it('returns empty when no override forces serving', () => {
    const overrides = overridesOf([
      ['p-off', { serveDns: false, upstreamOverride: null, cidr: '172.16.8.0/22' }],
      ['p-inherit', { serveDns: null, upstreamOverride: null, cidr: '172.16.8.0/22' }],
    ]);
    expect(dnsServeInterfaceIps(overrides, () => NICS)).toEqual([]);
  });

  it('returns empty when no local NIC falls inside a serve cidr', () => {
    const overrides = overridesOf([['p-on', { serveDns: true, upstreamOverride: null, cidr: '192.168.50.0/24' }]]);
    expect(dnsServeInterfaceIps(overrides, () => NICS)).toEqual([]);
  });

  it('does not enumerate NICs at all when there are no serve cidrs', () => {
    let called = 0;
    const overrides = overridesOf([['p-off', { serveDns: false, upstreamOverride: null, cidr: '10.0.0.0/24' }]]);
    dnsServeInterfaceIps(overrides, () => {
      called += 1;
      return NICS;
    });
    expect(called).toBe(0);
  });

  it('deduplicates a NIC IP matched by overlapping serve cidrs', () => {
    const overrides = overridesOf([
      ['p-narrow', { serveDns: true, upstreamOverride: null, cidr: '172.16.8.0/24' }],
      ['p-wide', { serveDns: true, upstreamOverride: null, cidr: '172.16.8.0/22' }],
    ]);
    const result = dnsServeInterfaceIps(overrides, () => NICS);
    expect(result.filter((entry) => entry.ip === '172.16.8.101')).toHaveLength(1);
  });
});

describe('unionInterfaceIps', () => {
  it('appends extra IPs not already served by DHCP', () => {
    const dhcp = [{ interface: 'br-brokkr', ip: '192.168.200.1', cidr: '192.168.200.0/24' }];
    const extra = [{ interface: 'enp1s0f1np1', ip: '172.16.8.101', cidr: '172.16.8.0/22' }];
    expect(unionInterfaceIps(dhcp, extra)).toEqual([...dhcp, ...extra]);
  });

  it('prefers the DHCP entry when both sets carry the same ip', () => {
    const dhcp = [{ interface: 'eth0', ip: '10.0.0.1', cidr: '10.0.0.0/24' }];
    const extra = [{ interface: 'eth0-alias', ip: '10.0.0.1', cidr: '10.0.0.0/16' }];
    expect(unionInterfaceIps(dhcp, extra)).toEqual(dhcp);
  });

  it('returns only DHCP entries when extra is empty (fail-closed baseline unchanged)', () => {
    const dhcp = [{ interface: 'eth0', ip: '10.0.0.1', cidr: '10.0.0.0/24' }];
    expect(unionInterfaceIps(dhcp, [])).toEqual(dhcp);
    expect(unionInterfaceIps([], [])).toEqual([]);
  });
});
