import {
  intToIpv4,
  ipAtOffset,
  ipInCidr,
  ipv4ToInt,
  isIpv4,
  isNetworkAddress,
  isRoutableUnicastIpv4,
  isValidIpv4Cidr,
  networkBase,
  parseCidr,
} from '..';
import vectors from '../ipv4.vectors.json';

describe('ipAtOffset', () => {
  it.each(vectors.ipAtOffset)('maps $cidr + $offset to $ip', ({ cidr, offset, ip }) => {
    expect(ipAtOffset(cidr, offset)).toBe(ip);
  });

  it('returns an empty string for a malformed cidr', () => {
    expect(ipAtOffset('192.168.1.0', 1)).toBe('');
    expect(ipAtOffset('192.168.1.0/33', 1)).toBe('');
  });

  it('returns an empty string when the offset leaves the address space', () => {
    expect(ipAtOffset('255.255.255.0/24', 256)).toBe('');
    expect(ipAtOffset('0.0.0.0/0', -1)).toBe('');
  });

  it('returns an empty string for a NaN offset', () => {
    expect(ipAtOffset('10.0.0.0/8', Number.NaN)).toBe('');
  });
});

describe('ipv4ToInt', () => {
  it('converts the boundary addresses', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
    expect(ipv4ToInt('10.0.0.5')).toBe(167772165);
    expect(ipv4ToInt('255.255.255.255')).toBe(4294967295);
  });

  it.each(['010.0.0.1', ' 1.2.3.4', '::1', '', '1.2.3.256', '1.2.3', '1.2.3.4.5'])('returns null for %j', (input) => {
    expect(ipv4ToInt(input)).toBeNull();
  });

  it('round-trips through intToIpv4', () => {
    expect(intToIpv4(167772165)).toBe('10.0.0.5');
    expect(intToIpv4(0xffffffff)).toBe('255.255.255.255');
  });
});

describe('isIpv4', () => {
  it('accepts dotted quads and rejects leading zeros', () => {
    expect(isIpv4('192.168.1.1')).toBe(true);
    expect(isIpv4('010.0.0.1')).toBe(false);
    expect(isIpv4('1e1.0.0.1')).toBe(false);
  });
});

describe('parseCidr', () => {
  it('keeps the host bits of the base address', () => {
    expect(parseCidr('192.168.105.9/24')).toEqual({ base: ipv4ToInt('192.168.105.9'), prefix: 24 });
  });

  it('rejects a missing, doubled or non-integer prefix', () => {
    expect(parseCidr('10.0.0.0')).toBeNull();
    expect(parseCidr('10.0.0.0/8/8')).toBeNull();
    expect(parseCidr('10.0.0.0/')).toBeNull();
    expect(parseCidr('10.0.0.0/24.0')).toBeNull();
    expect(parseCidr('10.0.0.0/ 24')).toBeNull();
    expect(parseCidr('10.0.0.0/33')).toBeNull();
  });

  it('agrees with isValidIpv4Cidr', () => {
    expect(isValidIpv4Cidr('10.0.0.0/8')).toBe(true);
    expect(isValidIpv4Cidr('10.0.0.0/33')).toBe(false);
  });
});

describe('networkBase', () => {
  it('masks the host bits away', () => {
    expect(networkBase('192.168.105.9/24')).toBe(ipv4ToInt('192.168.105.0'));
    expect(networkBase('0.0.0.0/0')).toBe(0);
  });

  it('returns null for a malformed cidr', () => {
    expect(networkBase('nope/24')).toBeNull();
  });
});

describe('ipInCidr', () => {
  it('ignores the host bits of the cidr', () => {
    expect(ipInCidr('192.168.105.200', '192.168.105.9/24')).toBe(true);
  });

  it('matches inside the prefix and rejects outside it', () => {
    expect(ipInCidr('10.0.1.100', '10.0.1.0/24')).toBe(true);
    expect(ipInCidr('10.0.1.255', '10.0.1.0/24')).toBe(true);
    expect(ipInCidr('10.0.2.0', '10.0.1.0/24')).toBe(false);
    expect(ipInCidr('10.0.0.1', '10.0.0.1/32')).toBe(true);
    expect(ipInCidr('10.0.0.2', '10.0.0.1/32')).toBe(false);
    expect(ipInCidr('192.168.1.1', '0.0.0.0/0')).toBe(true);
  });

  it('rejects a malformed ip or cidr', () => {
    expect(ipInCidr('10.0.0.1', '10.0.0.0')).toBe(false);
    expect(ipInCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
    expect(ipInCidr('::1', '10.0.0.0/8')).toBe(false);
  });
});

describe('isNetworkAddress', () => {
  it('accepts a masked base and rejects one carrying host bits', () => {
    expect(isNetworkAddress('192.168.1.0/24')).toBe(true);
    expect(isNetworkAddress('192.168.1.42/24')).toBe(false);
    expect(isNetworkAddress('0.0.0.0/0')).toBe(true);
  });

  it('rejects a malformed cidr', () => {
    expect(isNetworkAddress('192.168.1.0')).toBe(false);
  });
});

describe('isRoutableUnicastIpv4', () => {
  it('accepts ordinary unicast addresses', () => {
    expect(isRoutableUnicastIpv4('10.0.1.2')).toBe(true);
    expect(isRoutableUnicastIpv4('192.168.1.1')).toBe(true);
    expect(isRoutableUnicastIpv4('8.8.8.8')).toBe(true);
  });

  it('rejects unspecified, loopback, link-local, multicast and broadcast', () => {
    expect(isRoutableUnicastIpv4('0.0.0.0')).toBe(false);
    expect(isRoutableUnicastIpv4('127.0.0.1')).toBe(false);
    expect(isRoutableUnicastIpv4('169.254.1.1')).toBe(false);
    expect(isRoutableUnicastIpv4('224.0.0.1')).toBe(false);
    expect(isRoutableUnicastIpv4('239.255.255.250')).toBe(false);
    expect(isRoutableUnicastIpv4('255.255.255.255')).toBe(false);
  });

  it('rejects a malformed address', () => {
    expect(isRoutableUnicastIpv4('not-an-ip')).toBe(false);
  });
});
