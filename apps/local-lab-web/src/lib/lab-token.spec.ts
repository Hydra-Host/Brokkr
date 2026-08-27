import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { labApiToken, labTokenIsStackProvided, setLabApiToken, withLabToken } from './lab-token';

describe('lab-token', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('round-trips a token and trims it', () => {
    setLabApiToken('  sekret  ');
    expect(labApiToken()).toBe('sekret');
  });

  it('clears the token when set to blank', () => {
    setLabApiToken('sekret');
    setLabApiToken('   ');
    expect(labApiToken()).toBe('');
  });

  it('returns empty when no token is stored', () => {
    expect(labApiToken()).toBe('');
  });

  it('uses the token the devenv injected under lan.expose, so a lan browser needs no paste', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', '  injected  ');
    expect(labApiToken()).toBe('injected');
    expect(labTokenIsStackProvided()).toBe(true);
  });

  it('ignores a stored token while the stack serves one: a token typed to debug a 401 must not outlive it', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    setLabApiToken('typed-while-guessing');
    expect(labApiToken()).toBe('injected');
  });

  it('uses a stored token when nothing is injected (hand-run lab-web against another lab)', () => {
    setLabApiToken('pasted');
    expect(labApiToken()).toBe('pasted');
    expect(labTokenIsStackProvided()).toBe(false);
  });

  it('still returns the injected token when localStorage is unavailable', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable');
      },
    });
    expect(labApiToken()).toBe('injected');
  });

  it('does not throw when localStorage is unavailable (private mode / quota)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('locked');
      },
    });
    expect(() => setLabApiToken('sekret')).not.toThrow();
    expect(labApiToken()).toBe('');
  });

  it('appends the token as a query param, choosing ? or & correctly', () => {
    setLabApiToken('sek ret');
    expect(withLabToken('/api/fleet/shell')).toBe('/api/fleet/shell?token=sek%20ret');
    expect(withLabToken('/api/tests/term?run=1')).toBe('/api/tests/term?run=1&token=sek%20ret');
  });

  it('is a no-op on the URL when no token is set', () => {
    expect(withLabToken('/api/fleet/shell')).toBe('/api/fleet/shell');
  });
});
