import { describe, expect, it } from 'vitest';

import { cidrContainsIpv4, cidrMaskLength, findContainingPrefix, isValidIpv4, stripHostMask } from '../ip-utils';

describe('stripHostMask', () => {
  it('removes a trailing host mask', () => {
    expect(stripHostMask('10.0.0.5/24')).toBe('10.0.0.5');
  });

  it('returns bare addresses unchanged', () => {
    expect(stripHostMask('10.0.0.5')).toBe('10.0.0.5');
  });
});

describe('cidrMaskLength', () => {
  it('parses the mask length', () => {
    expect(cidrMaskLength('10.0.0.0/24')).toBe(24);
  });

  it('accepts /0 and /32', () => {
    expect(cidrMaskLength('0.0.0.0/0')).toBe(0);
    expect(cidrMaskLength('10.0.0.1/32')).toBe(32);
  });

  it('rejects masks above 32', () => {
    expect(cidrMaskLength('10.0.0.0/33')).toBeNull();
  });

  it('rejects bare addresses and malformed input', () => {
    expect(cidrMaskLength('10.0.0.0')).toBeNull();
    expect(cidrMaskLength('not-a-prefix/24')).toBeNull();
    expect(cidrMaskLength('10.0.0.0/abc')).toBeNull();
  });
});

describe('cidrContainsIpv4', () => {
  it('contains an address inside the block', () => {
    expect(cidrContainsIpv4('10.0.0.0/24', '10.0.0.42')).toBe(true);
  });

  it('contains the network and broadcast addresses', () => {
    expect(cidrContainsIpv4('10.0.0.0/24', '10.0.0.0')).toBe(true);
    expect(cidrContainsIpv4('10.0.0.0/24', '10.0.0.255')).toBe(true);
  });

  it('excludes an address outside the block', () => {
    expect(cidrContainsIpv4('10.0.0.0/24', '10.0.1.1')).toBe(false);
  });

  it('handles high addresses without sign issues', () => {
    expect(cidrContainsIpv4('192.168.1.0/24', '192.168.1.10')).toBe(true);
    expect(cidrContainsIpv4('255.255.255.0/24', '255.255.255.1')).toBe(true);
  });

  it('matches a /32 only exactly', () => {
    expect(cidrContainsIpv4('10.0.0.5/32', '10.0.0.5')).toBe(true);
    expect(cidrContainsIpv4('10.0.0.5/32', '10.0.0.6')).toBe(false);
  });

  it('matches everything for /0', () => {
    expect(cidrContainsIpv4('0.0.0.0/0', '203.0.113.9')).toBe(true);
  });

  it('accepts addresses carrying a host mask', () => {
    expect(cidrContainsIpv4('10.0.0.0/24', '10.0.0.5/24')).toBe(true);
  });

  it('rejects invalid cidr or address input', () => {
    expect(cidrContainsIpv4('10.0.0.0', '10.0.0.5')).toBe(false);
    expect(cidrContainsIpv4('10.0.0.0/24', '2001:db8::1')).toBe(false);
  });
});

describe('findContainingPrefix', () => {
  const prefixes = [
    { id: 'wide', prefix: '10.0.0.0/8', vrfId: null },
    { id: 'narrow', prefix: '10.1.2.0/24', vrfId: null },
    { id: 'other-vrf', prefix: '10.1.2.0/25', vrfId: 'vrf-1' },
    { id: 'unrelated', prefix: '192.168.0.0/16', vrfId: null },
  ];

  it('picks the most specific containing prefix', () => {
    expect(findContainingPrefix(prefixes, '10.1.2.3', null)?.id).toBe('narrow');
  });

  it('falls back to a wider containing prefix', () => {
    expect(findContainingPrefix(prefixes, '10.9.9.9', null)?.id).toBe('wide');
  });

  it('only matches prefixes in the same vrf', () => {
    expect(findContainingPrefix(prefixes, '10.1.2.3', 'vrf-1')?.id).toBe('other-vrf');
  });

  it('returns null when nothing contains the address', () => {
    expect(findContainingPrefix(prefixes, '172.16.0.1', null)).toBeNull();
  });

  it('ignores host masks on the address', () => {
    expect(findContainingPrefix(prefixes, '10.1.2.3/24', null)?.id).toBe('narrow');
  });
});

describe('isValidIpv4', () => {
  it('accepts a dotted quad', () => {
    expect(isValidIpv4('192.168.1.1')).toBe(true);
  });

  it('rejects out-of-range octets and ipv6', () => {
    expect(isValidIpv4('256.0.0.1')).toBe(false);
    expect(isValidIpv4('2001:db8::1')).toBe(false);
  });
});
