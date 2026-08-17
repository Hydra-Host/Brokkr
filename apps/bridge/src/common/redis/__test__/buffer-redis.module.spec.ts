import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import type { ResultPubSub } from '../../../agent/result-publisher/result-publisher.service';
import { BufferRedisModule } from '../buffer-redis.module';
import {
  BUFFER_REDIS,
  RedisBufferAdapter,
  type BufferAwareDriverPipeline,
  type BufferAwareRedisDriver,
} from '../redis-buffer-adapter';

function fakeDriver(close: () => Promise<void>): BufferAwareRedisDriver {
  const unused = (): never => {
    throw new Error('unused in this test');
  };
  return {
    set: unused,
    get: unused,
    del: unused,
    hgetall: unused,
    pipeline: (): BufferAwareDriverPipeline => unused(),
    subscribePubSub: (): ResultPubSub => unused(),
    close,
  };
}

describe('RedisBufferAdapter.close', () => {
  it('delegates to the driver', async () => {
    const close = vi.fn(async () => undefined);
    const adapter = new RedisBufferAdapter(fakeDriver(close));

    await adapter.close();

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('BufferRedisModule', () => {
  it('closes the buffer adapter exactly once on application shutdown', async () => {
    const close = vi.fn(async () => undefined);
    const moduleRef = await Test.createTestingModule({ imports: [BufferRedisModule] })
      .overrideProvider(BUFFER_REDIS)
      .useValue(new RedisBufferAdapter(fakeDriver(close)))
      .compile();
    await moduleRef.init();

    expect(close).not.toHaveBeenCalled();

    await moduleRef.close();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('swallows a failing adapter close so the remaining shutdown sweep still runs', async () => {
    const close = vi.fn(async () => {
      throw new Error('redis gone');
    });
    const moduleRef = await Test.createTestingModule({ imports: [BufferRedisModule] })
      .overrideProvider(BUFFER_REDIS)
      .useValue(new RedisBufferAdapter(fakeDriver(close)))
      .compile();
    await moduleRef.init();

    await expect(moduleRef.close()).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
