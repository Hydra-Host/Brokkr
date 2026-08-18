import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildStartupArgs, closeZoneCryptoBootstrapCache } from '../startup-args.js';

const { closeSpy } = vi.hoisted(() => ({ closeSpy: vi.fn(() => Promise.resolve()) }));

vi.mock('../../common/redis/redis-client/redis.client.js', () => ({
  RedisClient: class {
    close = closeSpy;
  },
}));

describe('closeZoneCryptoBootstrapCache', () => {
  beforeEach(() => {
    closeSpy.mockClear();
  });

  afterEach(async () => {
    await closeZoneCryptoBootstrapCache();
  });

  it('closes the client held by the bootstrap cache singleton exactly once', async () => {
    buildStartupArgs({}).zoneCryptoBootstrap.createBootstrap('job-1');

    await closeZoneCryptoBootstrapCache();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('clears the singleton so a repeat call does not close the same client twice', async () => {
    buildStartupArgs({}).zoneCryptoBootstrap.createBootstrap('job-1');

    await closeZoneCryptoBootstrapCache();
    await closeZoneCryptoBootstrapCache();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('resolves without closing anything when the cache was never created', async () => {
    await expect(closeZoneCryptoBootstrapCache()).resolves.toBeUndefined();
    expect(closeSpy).not.toHaveBeenCalled();
  });
});
