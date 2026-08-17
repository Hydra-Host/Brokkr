import { describe, expect, it } from 'vitest';
import { ipv4InCidr, ipv4ToInt } from '../ip-utils';

describe('ipv4ToInt', () => {
  it('converts 0.0.0.0 to 0', () => {
    expect(ipv4ToInt('0.0.0.0')).toBe(0);
  });

  it('converts 127.0.0.1 to the correct integer', () => {
    expect(ipv4ToInt('127.0.0.1')).toBe(0x7f000001);
  });

  it('converts 192.168.1.1 to the correct integer', () => {
    expect(ipv4ToInt('192.168.1.1')).toBe(((192 << 24) | (168 << 16) | (1 << 8) | 1) >>> 0);
  });

  it('converts 255.255.255.255 to 0xFFFFFFFF', () => {
    expect(ipv4ToInt('255.255.255.255')).toBe(0xffffffff);
  });

  it('returns null for an empty string', () => {
    expect(ipv4ToInt('')).toBeNull();
  });

  it('returns null for an IPv6 address', () => {
    expect(ipv4ToInt('::1')).toBeNull();
  });

  it('returns null when an octet exceeds 255', () => {
    expect(ipv4ToInt('256.0.0.1')).toBeNull();
  });

  it('returns null for non-numeric octets', () => {
    expect(ipv4ToInt('a.b.c.d')).toBeNull();
  });

  it('returns null for three-octet input', () => {
    expect(ipv4ToInt('10.0.1')).toBeNull();
  });

  it('returns null for five-octet input', () => {
    expect(ipv4ToInt('10.0.1.2.3')).toBeNull();
  });
});

describe('ipv4InCidr', () => {
  it('/0 matches all IPv4 addresses', () => {
    expect(ipv4InCidr('192.168.1.1', '0.0.0.0/0')).toBe(true);
  });

  it('/32 matches only the exact IP', () => {
    expect(ipv4InCidr('10.0.0.1', '10.0.0.1/32')).toBe(true);
    expect(ipv4InCidr('10.0.0.2', '10.0.0.1/32')).toBe(false);
  });

  it('/24 matches standard subnet membership', () => {
    expect(ipv4InCidr('10.0.1.100', '10.0.1.0/24')).toBe(true);
  });

  it('10.0.1.255 is inside 10.0.1.0/24', () => {
    expect(ipv4InCidr('10.0.1.255', '10.0.1.0/24')).toBe(true);
  });

  it('10.0.2.0 is outside 10.0.1.0/24', () => {
    expect(ipv4InCidr('10.0.2.0', '10.0.1.0/24')).toBe(false);
  });

  it('returns false when CIDR has no slash', () => {
    expect(ipv4InCidr('10.0.0.1', '10.0.0.0')).toBe(false);
  });

  it('returns false for an invalid mask (>32)', () => {
    expect(ipv4InCidr('10.0.0.1', '10.0.0.0/33')).toBe(false);
  });

  it('returns false for an empty mask after the slash', () => {
    expect(ipv4InCidr('10.0.0.1', '10.0.0.0/')).toBe(false);
  });

  it('returns false for a non-numeric mask', () => {
    expect(ipv4InCidr('10.0.0.1', '10.0.0.0/abc')).toBe(false);
  });

  it('returns false for a negative mask', () => {
    expect(ipv4InCidr('10.0.0.1', '10.0.0.0/-1')).toBe(false);
  });

  it('returns false for a floating-point mask', () => {
    expect(ipv4InCidr('10.0.0.1', '10.0.0.0/24.5')).toBe(false);
  });
});
