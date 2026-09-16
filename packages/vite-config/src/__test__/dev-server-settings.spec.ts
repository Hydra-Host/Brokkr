import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEV_PROXY_FORWARDING, devBindHost, devStrictPort } from '../dev-server.js';

describe('devBindHost', () => {
  beforeEach(() => {
    vi.stubEnv('HOST', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns undefined when HOST is unset and no fallback is given', () => {
    expect(devBindHost()).toBeUndefined();
  });

  it('returns the fallback when HOST is unset', () => {
    expect(devBindHost('127.0.0.1')).toBe('127.0.0.1');
  });

  it('prefers HOST over the fallback', () => {
    vi.stubEnv('HOST', '0.0.0.0');
    expect(devBindHost('127.0.0.1')).toBe('0.0.0.0');
  });
});

describe('devStrictPort', () => {
  beforeEach(() => {
    vi.stubEnv('PORT', '');
    vi.stubEnv('VITE_STRICT_PORT', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is strict when no port was named', () => {
    expect(devStrictPort()).toBe(true);
  });

  it('allows a fallback port when PORT was named', () => {
    vi.stubEnv('PORT', '5173');
    expect(devStrictPort()).toBe(false);
  });

  it('stays strict when VITE_STRICT_PORT overrides a named PORT', () => {
    vi.stubEnv('PORT', '5173');
    vi.stubEnv('VITE_STRICT_PORT', 'true');
    expect(devStrictPort()).toBe(true);
  });

  it('ignores a VITE_STRICT_PORT value other than the exact string true', () => {
    vi.stubEnv('PORT', '5173');
    vi.stubEnv('VITE_STRICT_PORT', '1');
    expect(devStrictPort()).toBe(false);
  });
});

describe('DEV_PROXY_FORWARDING', () => {
  it('rewrites the host and appends the forwarded headers', () => {
    expect(DEV_PROXY_FORWARDING).toEqual({ changeOrigin: true, xfwd: true });
  });
});
