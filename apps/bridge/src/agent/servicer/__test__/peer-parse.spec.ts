import { describe, expect, it, vi } from 'vitest';

import { parsePeerIp } from '../peer-parse';

describe('parsePeerIp — ipv4', () => {
  it('extracts the host from ipv4:host:port', () => {
    expect(parsePeerIp('ipv4:1.2.3.4:5678')).toBe('1.2.3.4');
  });

  it('returns null when the port separator is missing', () => {
    expect(parsePeerIp('ipv4:1.2.3.4')).toBeNull();
  });

  it('returns null when the host is empty', () => {
    expect(parsePeerIp('ipv4::5678')).toBeNull();
  });
});

describe('parsePeerIp — ipv6', () => {
  it('extracts the bracketed host from ipv6:[addr]:port', () => {
    expect(parsePeerIp('ipv6:[::1]:5678')).toBe('::1');
    expect(parsePeerIp('ipv6:[2001:db8::1]:443')).toBe('2001:db8::1');
  });

  it('returns the empty string for ipv6:[]:port (deliberate downstream contract)', () => {
    expect(parsePeerIp('ipv6:[]:5678')).toBe('');
  });

  it('returns null for ipv6 without brackets', () => {
    expect(parsePeerIp('ipv6:::1')).toBeNull();
    expect(parsePeerIp('ipv6:2001:db8::1')).toBeNull();
  });

  it('returns null for a bracketed ipv6 missing the "]:" terminator', () => {
    expect(parsePeerIp('ipv6:[::1]')).toBeNull();
  });
});

describe('parsePeerIp — invalid input', () => {
  it('returns null for an empty string', () => {
    expect(parsePeerIp('')).toBeNull();
  });

  it('returns null for non-string input', () => {
    expect(parsePeerIp(undefined)).toBeNull();
    expect(parsePeerIp(null)).toBeNull();
    expect(parsePeerIp(123)).toBeNull();
    expect(parsePeerIp({})).toBeNull();
  });

  it('returns null for a bare host with no scheme prefix', () => {
    expect(parsePeerIp('1.2.3.4')).toBeNull();
    expect(parsePeerIp('localhost:5678')).toBeNull();
  });
});

describe('parsePeerIp — forwarded metadata', () => {
  it('ignores forwarded metadata for a direct ipv4 peer', () => {
    const metadata = vi.fn(() => ['203.0.113.10']);

    expect(parsePeerIp('ipv4:10.0.0.5:5678', metadata)).toBe('10.0.0.5');
    expect(metadata).not.toHaveBeenCalled();
  });

  it('ignores forwarded metadata for a direct ipv6 peer', () => {
    const metadata = vi.fn(() => ['2001:db8::10']);

    expect(parsePeerIp('ipv6:[2001:db8::5]:5678', metadata)).toBe('2001:db8::5');
    expect(metadata).not.toHaveBeenCalled();
  });

  it('uses a valid x-real-ip for an ipv4 loopback peer', () => {
    const metadata = (key: string): readonly unknown[] => (key === 'x-real-ip' ? [' 10.0.0.5 '] : ['192.168.1.5']);

    expect(parsePeerIp('ipv4:127.0.0.1:5678', metadata)).toBe('10.0.0.5');
  });

  it('uses a valid x-real-ip for an ipv6 loopback peer', () => {
    const metadata = (key: string): readonly unknown[] => (key === 'x-real-ip' ? ['2001:db8::5'] : []);

    expect(parsePeerIp('ipv6:[::1]:5678', metadata)).toBe('2001:db8::5');
  });

  it('uses the rightmost valid x-forwarded-for value when x-real-ip is invalid', () => {
    const metadata = (key: string): readonly unknown[] => {
      if (key === 'x-real-ip') return ['invalid'];
      if (key === 'x-forwarded-for') return ['unknown, 10.0.0.8, 10.0.0.9'];
      return [];
    };

    expect(parsePeerIp('ipv4:127.0.0.1:5678', metadata)).toBe('10.0.0.9');
  });

  it('ignores a client-supplied leftmost x-forwarded-for entry in favor of the proxy-appended one', () => {
    const metadata = (key: string): readonly unknown[] =>
      key === 'x-forwarded-for' ? ['6.6.6.6, 10.0.0.8'] : [];

    expect(parsePeerIp('ipv4:127.0.0.1:5678', metadata)).toBe('10.0.0.8');
  });

  it('keeps the loopback peer when forwarded metadata has no valid address', () => {
    const metadata = (key: string): readonly unknown[] => (key === 'x-forwarded-for' ? ['unknown'] : []);

    expect(parsePeerIp('ipv4:127.0.0.1:5678', metadata)).toBe('127.0.0.1');
  });
});
