import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RedisService } from '../../common/redis/redis.service';
import { BmcCacheBinder } from '../bmc-cache-binder';
import { BmcCacheNotBoundError, getBmcCacheOrThrow, resetBmcCacheForTests } from '../bmc-cache-holder';
import {
  getTelegrafCacheOrThrow,
  resetTelegrafCacheForTests,
  TelegrafCacheNotBoundError,
} from '../telegraf-cache-holder';

const sentinelCache = { scan: async () => [], get: async () => null };

describe('BmcCacheBinder', () => {
  beforeEach(() => {
    resetBmcCacheForTests();
    resetTelegrafCacheForTests();
  });
  afterEach(() => {
    resetBmcCacheForTests();
    resetTelegrafCacheForTests();
  });

  it('throws BmcCacheNotBoundError before the bootstrap hook publishes the cache', () => {
    expect(() => getBmcCacheOrThrow()).toThrow(BmcCacheNotBoundError);
  });

  it('publishes the DI-injected RedisService into both the BMC and telegraf holders on bootstrap', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: RedisService, useValue: sentinelCache }, BmcCacheBinder],
    }).compile();

    const binder = moduleRef.get(BmcCacheBinder);
    expect(() => getBmcCacheOrThrow()).toThrow(BmcCacheNotBoundError);
    expect(() => getTelegrafCacheOrThrow()).toThrow(TelegrafCacheNotBoundError);

    binder.onApplicationBootstrap();

    expect(getBmcCacheOrThrow()).toBe(sentinelCache);
    expect(getTelegrafCacheOrThrow()).toBe(sentinelCache);
    await moduleRef.close();
  });
});
