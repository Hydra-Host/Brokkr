import { describe, expect, it } from 'vitest';

import { intToIp, ipAtOffset, ipInCidr, ipToInt, isIpv4, networkBase, NODE_IP_BASE, parseCidr } from './ipv4';
import vectors from './ipv4.vectors.json';

describe('ipAtOffset golden vectors', () => {
  for (const { cidr, offset, ip } of vectors.ipAtOffset) {
    it(`${cidr} + ${offset} = ${ip}`, () => {
      expect(ipAtOffset(cidr, offset)).toBe(ip);
    });
  }
});

describe('ipToInt / intToIp', () => {
  it('round-trips unsigned 32-bit', () => {
    expect(ipToInt('0.0.0.0')).toBe(0);
    expect(ipToInt('255.255.255.255')).toBe(4294967295);
    expect(ipToInt('192.168.200.10')).toBe(3232286730);
    expect(intToIp(3232286730)).toBe('192.168.200.10');
    expect(intToIp(0)).toBe('0.0.0.0');
    expect(intToIp(4294967295)).toBe('255.255.255.255');
  });
});

describe('parseCidr', () => {
  it('returns raw unmasked base and prefix for a valid cidr', () => {
    expect(parseCidr('192.168.200.77/24')).toEqual({ base: ipToInt('192.168.200.77'), prefix: 24 });
    expect(parseCidr('0.0.0.0/0')).toEqual({ base: 0, prefix: 0 });
    expect(parseCidr('10.0.0.5/32')).toEqual({ base: ipToInt('10.0.0.5'), prefix: 32 });
  });

  it('returns null for a bad quad, an out-of-range prefix, or empty', () => {
    expect(parseCidr('999.1.1.1/24')).toBeNull();
    expect(parseCidr('1.2.3/24')).toBeNull();
    expect(parseCidr('1.2.3.4/33')).toBeNull();
    expect(parseCidr('1.2.3.4/-1')).toBeNull();
    expect(parseCidr('1.2.3.4/2.5')).toBeNull();
    expect(parseCidr('1.2.3.4')).toBeNull();
    expect(parseCidr('1.2.3.4/')).toBeNull();
    expect(parseCidr('')).toBeNull();
  });

  it('returns null for Number()-coercible prefixes Python rejects', () => {
    expect(parseCidr('192.168.200.0/1e1')).toBeNull();
    expect(parseCidr('192.168.200.0/ 24')).toBeNull();
    expect(parseCidr('192.168.200.0/+24')).toBeNull();
    expect(parseCidr('192.168.200.0/0x18')).toBeNull();
    expect(parseCidr('192.168.200.0/24.0')).toBeNull();
    expect(parseCidr('010.0.0.0/8')).toBeNull();
  });
});

describe('networkBase', () => {
  it('masks to the network address', () => {
    expect(networkBase('192.168.200.77/24')).toBe(ipToInt('192.168.200.0'));
    expect(networkBase('10.0.0.5/8')).toBe(ipToInt('10.0.0.0'));
    expect(networkBase('0.0.0.0/0')).toBe(0);
    expect(networkBase('10.0.0.5/32')).toBe(ipToInt('10.0.0.5'));
  });

  it('returns null on a malformed cidr', () => {
    expect(networkBase('1.2.3.4/33')).toBeNull();
    expect(networkBase('nope')).toBeNull();
    expect(networkBase('')).toBeNull();
  });
});

describe('ipAtOffset malformed', () => {
  it("returns '' on a malformed cidr", () => {
    expect(ipAtOffset('1.2.3.4/33', 10)).toBe('');
    expect(ipAtOffset('nope', 1)).toBe('');
    expect(ipAtOffset('', 1)).toBe('');
    expect(ipAtOffset('192.168.200.0/1e1', 10)).toBe('');
  });

  it("returns '' instead of wrapping when the offset leaves the 32-bit space", () => {
    expect(ipAtOffset('255.255.255.255/32', 1)).toBe('');
    expect(ipAtOffset('0.0.0.0/0', -1)).toBe('');
  });

  it("returns '' for a non-finite offset instead of '0.0.0.0'", () => {
    expect(ipAtOffset('192.168.200.0/24', NaN)).toBe('');
    expect(ipAtOffset('192.168.200.0/24', Infinity)).toBe('');
  });
});

describe('ipInCidr', () => {
  it('masked membership truth table', () => {
    expect(ipInCidr('192.168.200.10', '192.168.200.0/24')).toBe(true);
    expect(ipInCidr('192.168.200.10', '192.168.200.77/24')).toBe(true);
    expect(ipInCidr('192.168.201.10', '192.168.200.0/24')).toBe(false);
    expect(ipInCidr('10.9.9.9', '10.0.0.0/8')).toBe(true);
    expect(ipInCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
  });

  it('returns false when either side is malformed', () => {
    expect(ipInCidr('999.1.1.1', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
    expect(ipInCidr('10.0.0.1', 'nope')).toBe(false);
    expect(ipInCidr('', '10.0.0.0/8')).toBe(false);
  });
});

describe('isIpv4', () => {
  it('accepts strict dotted quads with each octet 0-255', () => {
    expect(isIpv4('0.0.0.0')).toBe(true);
    expect(isIpv4('255.255.255.255')).toBe(true);
    expect(isIpv4('192.168.200.10')).toBe(true);
  });

  it('rejects out-of-range octets, wrong shapes, non-numeric, and leading zeros', () => {
    expect(isIpv4('256.0.0.1')).toBe(false);
    expect(isIpv4('1.2.3')).toBe(false);
    expect(isIpv4('1.2.3.4.5')).toBe(false);
    expect(isIpv4('1.2.3.4/24')).toBe(false);
    expect(isIpv4('a.b.c.d')).toBe(false);
    expect(isIpv4('')).toBe(false);
    expect(isIpv4('010.0.0.1')).toBe(false);
    expect(isIpv4('192.168.001.1')).toBe(false);
  });
});

describe('NODE_IP_BASE', () => {
  it('is 10', () => {
    expect(NODE_IP_BASE).toBe(10);
  });
});
