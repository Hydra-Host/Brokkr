import { afterEach, beforeEach } from 'vitest';

import { labBindHost, labCorsOrigins } from '../lab-auth';
import {
  effectiveClientAddress,
  extractToken,
  isConnectionAuthorized,
  isLoopbackAddress,
  tokenMatches,
} from '../lab-net';


const ORIG = { ...process.env };
afterEach(() => {
  process.env = { ...ORIG };
});

describe('isLoopbackAddress', () => {
  it('accepts the IPv4/IPv6 loopback range incl. IPv4-mapped IPv6', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost']) {
      expect(isLoopbackAddress(a)).toBe(true);
    }
  });

  it('rejects non-loopback and empty addresses (so they fall through to token auth)', () => {
    for (const a of ['10.0.0.5', '192.168.1.20', '0.0.0.0', '::ffff:10.0.0.5', undefined, null, '']) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });
});

describe('tokenMatches', () => {
  beforeEach(() => {
    process.env.LAB_API_TOKEN = 'sekret-token';
  });

  it('matches only the exact configured token', () => {
    expect(tokenMatches('sekret-token')).toBe(true);
    expect(tokenMatches('sekret-toke')).toBe(false);
    expect(tokenMatches('wrong-token!!')).toBe(false);
    expect(tokenMatches(undefined)).toBe(false);
  });

  it('never matches when no token is configured (fail-closed)', () => {
    delete process.env.LAB_API_TOKEN;
    expect(tokenMatches('anything')).toBe(false);
    expect(tokenMatches('')).toBe(false);
  });
});

describe('extractToken', () => {
  it('prefers Bearer, then x-lab-token header, then query param', () => {
    expect(extractToken('Bearer abc', 'hdr', 'q')).toBe('abc');
    expect(extractToken(undefined, 'hdr', 'q')).toBe('hdr');
    expect(extractToken(undefined, ['first', 'second'], 'q')).toBe('first');
    expect(extractToken(undefined, undefined, 'q')).toBe('q');
    expect(extractToken('Basic xyz', undefined, null)).toBeUndefined();
  });
});

describe('isConnectionAuthorized', () => {
  it('trusts loopback even with no token (the operator on the box / vite proxy)', () => {
    delete process.env.LAB_API_TOKEN;
    expect(isConnectionAuthorized('127.0.0.1', undefined, undefined)).toBe(true);
  });

  it('denies a non-loopback connection when no token is configured (fail-closed)', () => {
    delete process.env.LAB_API_TOKEN;
    expect(isConnectionAuthorized('10.0.0.5', 'whatever', undefined)).toBe(false);
  });

  it('gates a non-loopback connection on the shared token', () => {
    process.env.LAB_API_TOKEN = 'sekret-token';
    expect(isConnectionAuthorized('10.0.0.5', 'sekret-token', undefined)).toBe(true);
    expect(isConnectionAuthorized('10.0.0.5', 'nope', undefined)).toBe(false);
    expect(isConnectionAuthorized('10.0.0.5', undefined, undefined)).toBe(false);
  });

  it('resolves x-forwarded-for before deciding, so proxied lan ws upgrades are not loopback-trusted', () => {
    process.env.LAB_TRUST_PROXY = '1';
    delete process.env.LAB_API_TOKEN;
    expect(isConnectionAuthorized('127.0.0.1', undefined, '10.0.0.5')).toBe(false);
    process.env.LAB_API_TOKEN = 'sekret-token';
    expect(isConnectionAuthorized('127.0.0.1', 'sekret-token', '10.0.0.5')).toBe(true);
    expect(isConnectionAuthorized('127.0.0.1', undefined, '127.0.0.1')).toBe(true);
    delete process.env.LAB_TRUST_PROXY;
    expect(isConnectionAuthorized('127.0.0.1', undefined, '10.0.0.5')).toBe(true);
  });
});

describe('effectiveClientAddress / proxy trust matrix', () => {
  it('(a) trust unset: ignores XFF and keeps the loopback peer (today-behavior, trusted)', () => {
    delete process.env.LAB_TRUST_PROXY;
    delete process.env.LAB_API_TOKEN;
    const addr = effectiveClientAddress('127.0.0.1', '10.0.0.5');
    expect(addr).toBe('127.0.0.1');
    expect(isConnectionAuthorized(addr, undefined, undefined)).toBe(true);
  });

  it('(b) trust on + loopback peer + remote XFF: resolves to the LAN client, token required (fail-closed)', () => {
    process.env.LAB_TRUST_PROXY = '1';
    delete process.env.LAB_API_TOKEN;
    const addr = effectiveClientAddress('127.0.0.1', '10.0.0.5');
    expect(addr).toBe('10.0.0.5');
    expect(isLoopbackAddress(addr)).toBe(false);
    expect(isConnectionAuthorized(addr, undefined, undefined)).toBe(false);
  });

  it('(c) trust on + loopback peer + loopback XFF: still trusted', () => {
    process.env.LAB_TRUST_PROXY = '1';
    delete process.env.LAB_API_TOKEN;
    const addr = effectiveClientAddress('127.0.0.1', '127.0.0.1');
    expect(addr).toBe('127.0.0.1');
    expect(isConnectionAuthorized(addr, undefined, undefined)).toBe(true);
  });

  it('(d) trust on + NON-loopback peer: header ignored, falls through to the token path', () => {
    process.env.LAB_TRUST_PROXY = '1';
    const addr = effectiveClientAddress('10.0.0.5', '127.0.0.1');
    expect(addr).toBe('10.0.0.5');
    process.env.LAB_API_TOKEN = 'sekret-token';
    expect(isConnectionAuthorized(addr, 'sekret-token', undefined)).toBe(true);
    expect(isConnectionAuthorized(addr, undefined, undefined)).toBe(false);
  });

  it('(e) trust on + forged multi-entry XFF: only the last (proxy-appended) hop governs', () => {
    process.env.LAB_TRUST_PROXY = '1';
    delete process.env.LAB_API_TOKEN;
    const addr = effectiveClientAddress('127.0.0.1', 'evil, 127.0.0.1');
    expect(addr).toBe('127.0.0.1');
    expect(isConnectionAuthorized(addr, undefined, undefined)).toBe(true);
  });

  it('collapses a multi-header XFF array to its final hop', () => {
    process.env.LAB_TRUST_PROXY = '1';
    expect(effectiveClientAddress('127.0.0.1', ['evil', '10.0.0.5'])).toBe('10.0.0.5');
  });
});

describe('labBindHost', () => {
  it('defaults to loopback and only exposes on explicit opt-in', () => {
    delete process.env.LAB_BIND_HOST;
    expect(labBindHost()).toBe('127.0.0.1');
    process.env.LAB_BIND_HOST = '0.0.0.0';
    expect(labBindHost()).toBe('0.0.0.0');
  });
});

describe('labCorsOrigins', () => {
  it('never returns a wildcard/true — only concrete loopback origins by default', () => {
    delete process.env.LAB_CORS_ORIGINS;
    const origins = labCorsOrigins();
    expect(origins.every((o) => o.startsWith('http://localhost:') || o.startsWith('http://127.0.0.1:'))).toBe(true);
    expect(origins).not.toContain('*');
  });

  it('honors an explicit override list', () => {
    process.env.LAB_CORS_ORIGINS = 'https://lab.example.com, https://ops.example.com';
    expect(labCorsOrigins()).toEqual(['https://lab.example.com', 'https://ops.example.com']);
  });

  it('tracks the dev origin port when only PORT is set (mirrors Vite port resolution)', () => {
    delete process.env.LAB_CORS_ORIGINS;
    delete process.env.LAB_WEB_PORT;
    process.env.PORT = '4321';
    expect(labCorsOrigins()).toEqual(['http://localhost:4321', 'http://127.0.0.1:4321']);
  });

  it('prefers LAB_WEB_PORT over PORT', () => {
    delete process.env.LAB_CORS_ORIGINS;
    process.env.LAB_WEB_PORT = '5999';
    process.env.PORT = '4321';
    expect(labCorsOrigins()).toEqual(['http://localhost:5999', 'http://127.0.0.1:5999']);
  });
});
