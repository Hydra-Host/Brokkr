import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { streamPaths } from '@/contract';

import {
  hostExecToken,
  hostToken,
  hostTokenNeeded,
  labApiToken,
  labTokenIsStackProvided,
  setHostToken,
  setLabApiToken,
  withLabToken,
} from './lab-token';

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

describe('lab-token', () => {
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

  it('appends the token as a query param on the sse paths, choosing ? or & correctly', () => {
    setLabApiToken('sek ret');
    expect(withLabToken(streamPaths.run('r0'))).toBe('/api/runs/r0/stream?token=sek%20ret');
    expect(withLabToken(`${streamPaths.testEvents('r3')}?tail=1`)).toBe(
      '/api/tests/runs/r3/events/stream?tail=1&token=sek%20ret',
    );
  });

  it('is a no-op on the URL when no token is set', () => {
    expect(withLabToken(streamPaths.run('r0'))).toBe('/api/runs/r0/stream');
  });
});

describe('host token', () => {
  it('round-trips under its own key and trims it', () => {
    setHostToken('  host-sekret  ');
    expect(hostToken()).toBe('host-sekret');
  });

  it('clears the host token when set to blank', () => {
    setHostToken('host-sekret');
    setHostToken('   ');
    expect(hostToken()).toBe('');
  });

  it('keeps the host token out of ordinary calls: the api token never sees it', () => {
    setHostToken('host-sekret');
    expect(labApiToken()).toBe('');
    expect(hostToken()).toBe('host-sekret');
  });

  it('keeps the api token out of the host key', () => {
    setLabApiToken('api-sekret');
    expect(hostToken()).toBe('');
  });

  it('lets the typed host token outrank the injected one on a host-exec surface', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    setHostToken('host-sekret');
    expect(hostExecToken()).toBe('host-sekret');
    expect(labApiToken()).toBe('injected');
  });

  it('falls back to the ordinary token on a host-exec surface when none was typed', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    expect(hostExecToken()).toBe('injected');
  });

  it('is empty on loopback, where the address grants the capability and nothing is typed', () => {
    expect(hostExecToken()).toBe('');
    expect(hostTokenNeeded()).toBe(false);
  });

  it('needs a typed token exactly when the stack served one that cannot reach host-exec', () => {
    vi.stubEnv('VITE_LAB_API_TOKEN', 'injected');
    expect(hostTokenNeeded()).toBe(true);
    setHostToken('host-sekret');
    expect(hostTokenNeeded()).toBe(false);
  });

  it('never appends the host token to a stream URL', () => {
    setHostToken('host-sekret');
    expect(withLabToken('/api/runs/r0/stream')).toBe('/api/runs/r0/stream');
  });

  it('does not throw when localStorage is unavailable', () => {
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
    expect(() => setHostToken('host-sekret')).not.toThrow();
    expect(hostToken()).toBe('');
  });
});
