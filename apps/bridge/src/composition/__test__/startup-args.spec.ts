import { beforeEach, describe, expect, it, vi } from 'vitest';

const { closeSpy } = vi.hoisted(() => ({ closeSpy: vi.fn(() => Promise.resolve()) }));

vi.mock('../../common/redis/redis-client/redis.client.js', () => ({
  RedisClient: class {
    close = closeSpy;
  },
}));

async function loadFreshStartupArgs(): Promise<typeof import('../startup-args.js')> {
  vi.resetModules();
  return import('../startup-args.js');
}

describe('closeZoneCryptoBootstrapCache', () => {
  beforeEach(() => {
    closeSpy.mockClear();
  });

  it('closes the client held by the bootstrap cache singleton exactly once', async () => {
    const startupArgs = await loadFreshStartupArgs();
    startupArgs.buildStartupArgs({}).zoneCryptoBootstrap.createBootstrap('job-1');

    await startupArgs.closeZoneCryptoBootstrapCache();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the singleton so a repeat call does not close the same client twice', async () => {
    const startupArgs = await loadFreshStartupArgs();
    startupArgs.buildStartupArgs({}).zoneCryptoBootstrap.createBootstrap('job-1');

    await startupArgs.closeZoneCryptoBootstrapCache();
    await startupArgs.closeZoneCryptoBootstrapCache();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves without closing anything when the cache was never created', async () => {
    const startupArgs = await loadFreshStartupArgs();

    await expect(startupArgs.closeZoneCryptoBootstrapCache()).resolves.toBeUndefined();
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
