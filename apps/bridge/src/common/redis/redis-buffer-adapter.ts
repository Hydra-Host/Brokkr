import type {
  RedisPipeline,
  ResultPublisherRedis,
  ResultPubSub,
} from '../../agent/result-publisher/result-publisher.service';

import { buildBufferRedisDriver } from './redis-buffer-driver';

export const BUFFER_REDIS: unique symbol = Symbol('BUFFER_REDIS');

export interface BufferAwareDriverPipeline {
  set(key: string, value: string | Buffer, exSeconds: number): BufferAwareDriverPipeline;
  publish(channel: string, message: string): BufferAwareDriverPipeline;
  hset(key: string, fields: Record<string, string>): BufferAwareDriverPipeline;
  expire(key: string, seconds: number): BufferAwareDriverPipeline;
  rpush(key: string, value: string | Buffer): BufferAwareDriverPipeline;
  exec(): Promise<unknown[]>;
}

export interface BufferAwareRedisDriver {
  set(key: string, value: string | Buffer, exSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | Buffer | null>;
  del(key: string): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  pipeline(): BufferAwareDriverPipeline;
  subscribePubSub(): ResultPubSub;
  close(): Promise<void>;
}

export type BufferAwareRedisDriverFactory = () => BufferAwareRedisDriver;

export class RedisBufferAdapter implements ResultPublisherRedis {
  constructor(private readonly driver: BufferAwareRedisDriver) {}

  async set(key: string, value: string | Buffer, exSeconds: number): Promise<unknown> {
    return this.driver.set(key, value, exSeconds);
  }

  async get(key: string): Promise<string | Buffer | null> {
    return this.driver.get(key);
  }

  async del(key: string): Promise<unknown> {
    return this.driver.del(key);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.driver.hgetall(key);
  }

  pipeline(): RedisPipeline {
    return this.driver.pipeline();
  }

  subscribePubSub(): ResultPubSub {
    return this.driver.subscribePubSub();
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

const NOT_WIRED_MESSAGE =
  'app-root composition stub: BufferAwareRedisDriver not yet bound — production code reached a buffer-Redis op before a real driver was wired';

function notWiredBufferDriver(): BufferAwareRedisDriver {
  const fail = (): never => {
    throw new Error(NOT_WIRED_MESSAGE);
  };
  return {
    set: () => Promise.reject(new Error(NOT_WIRED_MESSAGE)),
    get: () => Promise.reject(new Error(NOT_WIRED_MESSAGE)),
    del: () => Promise.reject(new Error(NOT_WIRED_MESSAGE)),
    hgetall: () => Promise.reject(new Error(NOT_WIRED_MESSAGE)),
    pipeline: () => {
      const pipe: BufferAwareDriverPipeline = {
        set: () => pipe,
        publish: () => pipe,
        hset: () => pipe,
        expire: () => pipe,
        rpush: () => pipe,
        exec: () => Promise.reject(new Error(NOT_WIRED_MESSAGE)),
      };
      return pipe;
    },
    subscribePubSub: () => ({
      subscribe: () => Promise.reject(new Error(NOT_WIRED_MESSAGE)),
      unsubscribe: () => Promise.reject(new Error(NOT_WIRED_MESSAGE)),
      close: () => Promise.reject(new Error(NOT_WIRED_MESSAGE)),
      getMessage: () => Promise.reject(new Error(NOT_WIRED_MESSAGE)),
    }),
    // resolves rather than rejects: a shutdown hook closing a driver that was never wired has
    // nothing to release, and a rejection there would mask the real teardown error.
    close: () => Promise.resolve(),
    [Symbol.for('notWired-eager')]: fail,
  } as BufferAwareRedisDriver;
}

export function buildNotWiredBufferRedisAdapter(): RedisBufferAdapter {
  return new RedisBufferAdapter(notWiredBufferDriver());
}

export function buildBufferRedisAdapter(): RedisBufferAdapter {
  return new RedisBufferAdapter(buildBufferRedisDriver());
}
