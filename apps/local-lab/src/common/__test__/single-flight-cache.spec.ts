import { vi } from 'vitest';

import { SingleFlightCache } from '../single-flight-cache';

describe('SingleFlightCache', () => {
  it('dedupes concurrent loads into a single call', async () => {
    let release!: (v: number) => void;
    const load = vi.fn(() => new Promise<number>((r) => (release = r)));
    const cache = new SingleFlightCache<number>({ load });

    const all = Promise.all([cache.get(), cache.get(), cache.get()]);
    release(42);

    expect(await all).toEqual([42, 42, 42]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('caches a success until invalidated', async () => {
    const load = vi.fn(async () => 'v');
    const cache = new SingleFlightCache<string>({ load });

    expect(await cache.get()).toBe('v');
    expect(await cache.get()).toBe('v');
    expect(load).toHaveBeenCalledTimes(1);

    cache.invalidate();
    expect(await cache.get()).toBe('v');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('expires a TTL-cached value and reloads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const load = vi.fn(async () => Date.now());
    const cache = new SingleFlightCache<number>({ load, ttlMs: 30_000 });

    expect(await cache.get()).toBe(0);
    vi.setSystemTime(29_000);
    expect(await cache.get()).toBe(0);
    vi.setSystemTime(30_000);
    expect(await cache.get()).toBe(30_000);

    expect(load).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('degrades to the fallback on failure and negatively-caches within the cooldown', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const load = vi.fn(async (): Promise<Record<string, unknown>> => {
      throw new Error('boom');
    });
    const onError = vi.fn();
    const cache = new SingleFlightCache<Record<string, unknown>>({
      load,
      cooldownMs: 30_000,
      degrade: () => ({}),
      onError,
    });

    expect(await cache.get()).toEqual({});
    expect(await cache.get()).toEqual({});
    expect(load).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);

    vi.setSystemTime(31_000);
    expect(await cache.get()).toEqual({});
    expect(load).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('throws (re-throwing the cause, then the cooldown message) when no degrade is configured', async () => {
    const load = vi.fn(async (): Promise<string> => {
      throw new Error('no devenv');
    });
    const cache = new SingleFlightCache<string>({ load, cooldownMs: 30_000, cooldownMessage: 'cooling down' });

    await expect(cache.get()).rejects.toThrow('no devenv');
    await expect(cache.get()).rejects.toThrow('cooling down');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never caches a load whose generation was bumped mid-flight (retry → fresh)', async () => {
    let releaseStale!: (v: string) => void;
    const load = vi
      .fn(async () => 'fresh')
      .mockImplementationOnce(() => new Promise<string>((r) => (releaseStale = r)));
    const cache = new SingleFlightCache<string>({ load, maxAttempts: 3 });

    const inflight = cache.get();
    cache.invalidate();
    releaseStale('stale');

    expect(await inflight).toBe('fresh');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('throws staleMessage after retry exhaustion rather than returning a stale value', async () => {
    const cache: SingleFlightCache<string> = new SingleFlightCache<string>({
      load: async () => {
        cache.invalidate();
        return 'stale';
      },
      maxAttempts: 3,
      staleMessage: 'kept changing',
    });

    await expect(cache.get()).rejects.toThrow('kept changing');
  });

  it('does not arm the cooldown when a failing load straddled an invalidate()', async () => {
    let rejectStale!: (e: Error) => void;
    const load = vi
      .fn(async () => 'fresh')
      .mockImplementationOnce(() => new Promise<string>((_resolve, reject) => (rejectStale = reject)));
    const cache = new SingleFlightCache<string>({ load, cooldownMs: 30_000, cooldownMessage: 'cooling down' });

    const inflight = cache.get();
    cache.invalidate();
    rejectStale(new Error('boom'));

    await expect(inflight).rejects.toThrow('boom');
    expect(await cache.get()).toBe('fresh');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('prime() commits an out-of-band load so get() serves the fresh value', async () => {
    let n = 0;
    const cache = new SingleFlightCache<number>({ load: () => Promise.resolve(++n), ttlMs: 60_000 });
    await expect(cache.get()).resolves.toBe(1);
    await expect(cache.prime(() => Promise.resolve(99))).resolves.toBe(99);
    await expect(cache.get()).resolves.toBe(99);
    expect(n).toBe(1);
  });

  it('a load in flight when prime() commits cannot overwrite the primed value', async () => {
    let release!: (v: number) => void;
    const cache = new SingleFlightCache<number>({
      load: () => new Promise<number>((r) => (release = r)),
      ttlMs: 60_000,
    });
    const stale = cache.get();
    await expect(cache.prime(() => Promise.resolve(99))).resolves.toBe(99);
    release(1);
    await expect(stale).resolves.toBe(1);
    await expect(cache.get()).resolves.toBe(99);
  });

  it('prime() does not commit when the generation was bumped mid-load', async () => {
    const cache = new SingleFlightCache<number>({ load: () => Promise.resolve(1) });
    let release!: (v: number) => void;
    const primed = cache.prime(() => new Promise<number>((r) => (release = r)));
    cache.invalidate();
    release(99);
    await expect(primed).resolves.toBe(99);
    await expect(cache.get()).resolves.toBe(1);
  });

  it('a stale flight completing does not clear a successor generation in-flight slot', async () => {
    const resolvers: Array<(v: string) => void> = [];
    const load = vi.fn(() => new Promise<string>((resolve) => resolvers.push(resolve)));
    const cache = new SingleFlightCache<string>({ load });

    const get1 = cache.get();
    cache.invalidate();
    const get2 = cache.get();
    expect(load).toHaveBeenCalledTimes(2);

    resolvers[0]('stale');
    await get1;

    const get3 = cache.get();
    expect(load).toHaveBeenCalledTimes(2);

    resolvers[1]('fresh');
    expect(await get2).toBe('fresh');
    expect(await get3).toBe('fresh');
    expect(load).toHaveBeenCalledTimes(2);
  });
});
