import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';

import {
  BUFFER_REDIS,
  RedisBufferAdapter,
  type BufferAwareDriverPipeline,
  type BufferAwareRedisDriver,
} from '../../../common/redis/redis-buffer-adapter';
import { ResultPublisherModule } from '../result-publisher.module';
import { ResultPublisherService } from '../result-publisher.service';

interface SetRecord {
  value: string | Buffer;
  exSeconds: number;
}

class InMemoryBufferDriver implements BufferAwareRedisDriver {
  readonly strings = new Map<string, SetRecord>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly hashTtls = new Map<string, number>();

  async set(key: string, value: string | Buffer, exSeconds: number): Promise<unknown> {
    this.strings.set(key, { value, exSeconds });
    return 'OK';
  }

  async get(key: string): Promise<string | Buffer | null> {
    const rec = this.strings.get(key);
    return rec === undefined ? null : rec.value;
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    return hash === undefined ? {} : Object.fromEntries(hash);
  }

  pipeline(): BufferAwareDriverPipeline {
    const ops: Array<() => void> = [];
    const pipe: BufferAwareDriverPipeline = {
      set: (key, value, exSeconds) => {
        ops.push(() => this.strings.set(key, { value, exSeconds }));
        return pipe;
      },
      publish: () => {
        return pipe;
      },
      hset: (key, fields) => {
        ops.push(() => {
          let h = this.hashes.get(key);
          if (h === undefined) {
            h = new Map();
            this.hashes.set(key, h);
          }
          for (const [k, v] of Object.entries(fields)) h.set(k, v);
        });
        return pipe;
      },
      expire: (key, seconds) => {
        ops.push(() => this.hashTtls.set(key, seconds));
        return pipe;
      },
      rpush: () => {
        return pipe;
      },
      exec: async () => {
        for (const op of ops) op();
        return [];
      },
    };
    return pipe;
  }

  subscribePubSub(): never {
    throw new Error('pubsub not exercised in this wiring test');
  }

  async close(): Promise<void> {}
}

@Global()
@Module({
  providers: [
    {
      provide: BUFFER_REDIS,
      useFactory: () => new RedisBufferAdapter(new InMemoryBufferDriver()),
    },
  ],
  exports: [BUFFER_REDIS],
})
class FakeBufferRedisModule {}

describe('ResultPublisherModule composition', () => {
  it('resolves ResultPublisherService from DI with the BUFFER_REDIS adapter', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [FakeBufferRedisModule, ResultPublisherModule.forRoot({ redisToken: BUFFER_REDIS, zonePrefix: '' })],
    }).compile();

    const publisher = moduleRef.get(ResultPublisherService);
    expect(publisher).toBeInstanceOf(ResultPublisherService);
    await moduleRef.close();
  });

  it('getProgress reads progress through the BUFFER_REDIS adapter', async () => {
    const driver = new InMemoryBufferDriver();
    const adapter = new RedisBufferAdapter(driver);
    const publisher = new ResultPublisherService(adapter, 'zone-abc');
    await publisher.publishProgress('wid-int', 0.5, 'half done');

    await expect(publisher.getProgress('wid-int')).resolves.toMatchObject({
      progress: '0.5',
      message: 'half done',
    });
  });

  it('publishProgress writes the result-publisher-keys-v1 key shape under the zone prefix', async () => {
    const driver = new InMemoryBufferDriver();
    const adapter = new RedisBufferAdapter(driver);

    @Global()
    @Module({
      providers: [{ provide: BUFFER_REDIS, useValue: adapter }],
      exports: [BUFFER_REDIS],
    })
    class HostedDriverModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        HostedDriverModule,
        ResultPublisherModule.forRoot({
          redisToken: BUFFER_REDIS,
          zonePrefix: 'zone-abc',
        }),
      ],
    }).compile();

    const publisher = moduleRef.get(ResultPublisherService);
    await publisher.publishProgress('wid-int', 0.5, 'half done');

    expect(driver.hashes.has('zone-abc:work:progress:wid-int')).toBe(true);
    expect(driver.hashes.has('work:progress:wid-int')).toBe(false);
    const fields = driver.hashes.get('zone-abc:work:progress:wid-int');
    expect(fields?.get('progress')).toBe('0.5');
    expect(fields?.get('message')).toBe('half done');
    expect(driver.hashTtls.get('zone-abc:work:progress:wid-int')).toBe(60 * 60);

    await moduleRef.close();
  });
});
