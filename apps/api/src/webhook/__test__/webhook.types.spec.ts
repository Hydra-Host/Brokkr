import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  tlsConnect: vi.fn(),
}));
vi.mock('dns', () => ({ promises: { resolve4: h.resolve4, resolve6: h.resolve6 } }));
vi.mock('tls', () => ({ connect: h.tlsConnect }));

import {
  assertSafeDeliveryUrl,
  isPrivateIPv4,
  isPublicHttpsUrl,
  isReservedIPv6,
  PinnedIpHttpsAgent,
  SsrfBlockedError,
} from '../webhook.types';

const dnsErr = (code: string) => Object.assign(new Error(code), { code });

describe('isPrivateIPv4', () => {
  it.each([
    [0, 0, true],
    [10, 0, true],
    [127, 0, true],
    [172, 16, true],
    [172, 31, true],
    [192, 168, true],
    [169, 254, true],
  ])('treats %d.%d.x.x as private', (a, b, expected) => {
    expect(isPrivateIPv4(a, b)).toBe(expected);
  });

  it.each([
    [172, 15],
    [172, 32],
    [192, 167],
    [169, 253],
    [8, 8],
    [93, 184],
  ])('treats %d.%d.x.x as public', (a, b) => {
    expect(isPrivateIPv4(a, b)).toBe(false);
  });
});

describe('isPublicHttpsUrl (input-time literal guard)', () => {
  it.each([
    'https://example.com/hooks',
    'https://hooks.example.org:8443/path',
    'https://[2606:2800:220:1:248:1893:25c8:1946]/x',
    'https://[::ffff:5db8:d822]/x',
  ])('accepts %s', (url) => {
    expect(isPublicHttpsUrl(url)).toBe(true);
  });

  it.each([
    ['non-https scheme', 'http://example.com/hooks'],
    ['malformed url', 'not-a-url'],
    ['localhost', 'https://localhost/hooks'],
    ['*.localhost', 'https://api.localhost/hooks'],
    ['*.local mDNS', 'https://printer.local/hooks'],
    ['loopback ipv4', 'https://127.0.0.1/hooks'],
    ['0.0.0.0', 'https://0.0.0.0/hooks'],
    ['private 10/8', 'https://10.1.2.3/hooks'],
    ['private 172.16/12', 'https://172.16.0.1/hooks'],
    ['private 192.168/16', 'https://192.168.1.10/hooks'],
    ['cloud metadata 169.254', 'https://169.254.169.254/latest/meta-data'],
    ['ipv6 loopback', 'https://[::1]/hooks'],
    ['ipv6 unspecified', 'https://[::]/hooks'],
    ['ipv6 ULA fc00::/7 (fc)', 'https://[fc00::1]/hooks'],
    ['ipv6 ULA fc00::/7 (fd)', 'https://[fd12:3456::1]/hooks'],
    ['ipv6 link-local fe80::/10', 'https://[fe80::1]/hooks'],
    ['::ffff: mapped private (hex)', 'https://[::ffff:c0a8:0101]/hooks'],
  ])('rejects %s', (_label, url) => {
    expect(isPublicHttpsUrl(url)).toBe(false);
  });
});

describe('isReservedIPv6 (delivery-time allowlist)', () => {
  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['ff02::1', 'multicast'],
    ['fc00::1', 'ULA fc'],
    ['fd12:3456::1', 'ULA fd'],
    ['fe80::1', 'link-local'],
    ['fec0::1', 'decommissioned site-local'],
    ['100::1', 'discard-only 100::/64'],
    ['64:ff9b::1.2.3.4', 'NAT64'],
    ['2001:db8::1', 'documentation'],
    ['2001::abcd', 'Teredo 2001::/32'],
    ['2002:c0a8:0101::1', '6to4'],
    ['4000::1', 'outside 2000::/3 global unicast'],
  ])('blocks %s (%s)', (addr) => {
    expect(isReservedIPv6(addr)).toBe(true);
  });

  it.each([
    '2606:2800:220:1:248:1893:25c8:1946',
    '2001:4860:4860::8888',
    '3fff::1',
  ])('allows public global-unicast %s', (addr) => {
    expect(isReservedIPv6(addr)).toBe(false);
  });
});

describe('assertSafeDeliveryUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resolve4.mockRejectedValue(dnsErr('ENODATA'));
    h.resolve6.mockRejectedValue(dnsErr('ENODATA'));
  });

  it('skips DNS for a raw IPv4 literal (already validated at input time)', async () => {
    await expect(assertSafeDeliveryUrl('https://93.184.216.34/x')).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
    expect(h.resolve4).not.toHaveBeenCalled();
    expect(h.resolve6).not.toHaveBeenCalled();
  });

  it('skips DNS for a raw IPv6 literal and strips the brackets', async () => {
    await expect(assertSafeDeliveryUrl('https://[2606:2800:220:1::1]/x')).resolves.toEqual({
      address: '2606:2800:220:1::1',
      family: 6,
    });
    expect(h.resolve6).not.toHaveBeenCalled();
  });

  it('returns the resolved public IPv4', async () => {
    h.resolve4.mockResolvedValue(['93.184.216.34']);
    await expect(assertSafeDeliveryUrl('https://example.com/x')).resolves.toEqual({
      address: '93.184.216.34',
      family: 4,
    });
  });

  it.each([
    ['cloud metadata', '169.254.169.254'],
    ['RFC1918 10/8', '10.0.0.5'],
    ['loopback', '127.0.0.1'],
  ])('blocks a hostname that resolves to a private IPv4 (%s) — DNS-rebinding defense', async (_label, ip) => {
    h.resolve4.mockResolvedValue([ip]);
    await expect(assertSafeDeliveryUrl('https://rebind.example.com/x')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks a hostname that resolves to a reserved IPv6 (ULA)', async () => {
    h.resolve6.mockResolvedValue(['fc00::1']);
    await expect(assertSafeDeliveryUrl('https://rebind.example.com/x')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks a resolved ::ffff: IPv4-mapped private address', async () => {
    h.resolve6.mockResolvedValue(['::ffff:c0a8:0101']);
    await expect(assertSafeDeliveryUrl('https://rebind.example.com/x')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('allows a resolved public global-unicast IPv6', async () => {
    h.resolve6.mockResolvedValue(['2606:2800:220:1::1']);
    await expect(assertSafeDeliveryUrl('https://example.com/x')).resolves.toEqual({
      address: '2606:2800:220:1::1',
      family: 6,
    });
  });

  it('throws SsrfBlockedError (permanent) when the hostname cannot be resolved', async () => {
    h.resolve4.mockRejectedValue(dnsErr('ENOTFOUND'));
    h.resolve6.mockRejectedValue(dnsErr('ENOTFOUND'));
    await expect(assertSafeDeliveryUrl('https://nope.example.com/x')).rejects.toBeInstanceOf(SsrfBlockedError);
  });

  it('throws a retryable Error (not SsrfBlockedError) on a transient DNS failure', async () => {
    h.resolve4.mockRejectedValue(dnsErr('ETIMEOUT'));
    h.resolve6.mockRejectedValue(dnsErr('ETIMEOUT'));
    const p = assertSafeDeliveryUrl('https://flaky.example.com/x');
    await expect(p).rejects.toThrow(/will retry/);
    await expect(p).rejects.not.toBeInstanceOf(SsrfBlockedError);
  });
});

describe('PinnedIpHttpsAgent (DNS-rebinding TOCTOU close)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.tlsConnect.mockReturnValue(new EventEmitter());
  });

  it('connects to the validated IP, keeps the original hostname as SNI, and validates certs', () => {
    const agent = new PinnedIpHttpsAgent('93.184.216.34', 'example.com');
    agent.createConnection({ port: 443 }, undefined);
    expect(h.tlsConnect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '93.184.216.34',
        port: 443,
        servername: 'example.com',
        rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1'],
      }),
    );
  });

  it('parses a string port and defaults to 443', () => {
    const agent = new PinnedIpHttpsAgent('93.184.216.34', 'example.com');
    agent.createConnection({ port: '8443' }, undefined);
    expect(h.tlsConnect).toHaveBeenCalledWith(expect.objectContaining({ port: 8443 }));

    h.tlsConnect.mockClear();
    agent.createConnection({}, undefined);
    expect(h.tlsConnect).toHaveBeenCalledWith(expect.objectContaining({ port: 443 }));
  });

  it('invokes the callback with the socket on secureConnect', () => {
    const socket = new EventEmitter();
    h.tlsConnect.mockReturnValue(socket);
    const agent = new PinnedIpHttpsAgent('93.184.216.34', 'example.com');
    const cb = vi.fn();
    agent.createConnection({ port: 443 }, cb);
    socket.emit('secureConnect');
    expect(cb).toHaveBeenCalledWith(null, socket);
  });

  it('invokes the callback with the error on connect failure', () => {
    const socket = new EventEmitter();
    h.tlsConnect.mockReturnValue(socket);
    const agent = new PinnedIpHttpsAgent('93.184.216.34', 'example.com');
    const cb = vi.fn();
    agent.createConnection({ port: 443 }, cb);
    const err = new Error('connect failed');
    socket.emit('error', err);
    expect(cb).toHaveBeenCalledWith(err, socket);
  });
});
