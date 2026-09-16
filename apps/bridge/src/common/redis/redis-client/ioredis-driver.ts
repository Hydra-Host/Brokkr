import { readFileSync } from 'node:fs';

import { Redis, type RedisOptions } from 'ioredis';

import { labelRedisStream } from '../redis-handle-label';
import { quitThenDisconnect } from '../redis-teardown';

import type { RedisDriver, RedisDriverFactory, RedisDriverPipeline } from './redis-driver';
import type { RedisConfig } from './redis.config';
import { RedisConnectionError, RedisOperationError } from './redis.errors';

const TCP_KEEPALIVE_INITIAL_DELAY_MS = 120_000;

function buildRedisOptions(config: RedisConfig): RedisOptions {
  const options: RedisOptions = {
    host: config.host,
    port: config.port,
    db: config.db,
    username: config.username || undefined,
    password: config.password || undefined,
    commandTimeout: Math.round(config.socketTimeout * 1000),
    connectTimeout: Math.round(config.socketConnectTimeout * 1000),
    keepAlive: TCP_KEEPALIVE_INITIAL_DELAY_MS,
    maxRetriesPerRequest: config.retryOnError ? null : 0,
    lazyConnect: true,
    enableAutoPipelining: false,
    enableOfflineQueue: true,
  };
  if (config.tls) {
    options.tls = config.tlsCaCert ? { ca: readFileSync(config.tlsCaCert) } : {};
  }
  return options;
}

class IoredisPipeline implements RedisDriverPipeline {
  private readonly pipe: ReturnType<Redis['pipeline']>;

  constructor(pipe: ReturnType<Redis['pipeline']>) {
    this.pipe = pipe;
  }

  hset(key: string, mapping: Record<string, string>): RedisDriverPipeline {
    this.pipe.hset(key, mapping);
    return this;
  }

  expire(key: string, seconds: number): RedisDriverPipeline {
    this.pipe.expire(key, seconds);
    return this;
  }

  async exec(): Promise<unknown[]> {
    const results = await this.pipe.exec();
    if (results === null) {
      throw new RedisOperationError('Pipeline exec aborted (null result)');
    }
    const flattened: unknown[] = [];
    for (const entry of results) {
      const [err, value] = entry;
      if (err) {
        throw err;
      }
      flattened.push(value);
    }
    return flattened;
  }
}

class IoredisDriver implements RedisDriver {
  private readonly client: Redis;
  private readonly label: string;

  constructor(client: Redis, label: string) {
    this.client = client;
    this.label = label;
  }

  async ping(): Promise<unknown> {
    return this.client.ping();
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string): Promise<unknown> {
    return this.client.set(key, value);
  }

  async setex(key: string, ttl: number, value: string): Promise<unknown> {
    return this.client.setex(key, ttl, value);
  }

  async setNx(key: string, value: string, ttl?: number): Promise<boolean> {
    const result =
      ttl !== undefined && ttl > 0
        ? await this.client.set(key, value, 'EX', ttl, 'NX')
        : await this.client.set(key, value, 'NX');
    return result !== null;
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async exists(key: string): Promise<number> {
    return this.client.exists(key);
  }

  async rpush(key: string, values: string[]): Promise<number> {
    return this.client.rpush(key, ...values);
  }

  async xadd(key: string, fields: Record<string, string>, maxlen?: number): Promise<string> {
    const args: string[] = [];
    for (const [field, value] of Object.entries(fields)) {
      args.push(field, value);
    }
    const id =
      maxlen === undefined
        ? await this.client.xadd(key, '*', ...args)
        : await this.client.xadd(key, 'MAXLEN', '~', maxlen, '*', ...args);
    return id ?? '';
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async expire(key: string, seconds: number): Promise<number> {
    return this.client.expire(key, seconds);
  }

  async hset(key: string, mapping: Record<string, string>): Promise<number> {
    return this.client.hset(key, mapping);
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.client.hget(key, field);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  scanMatch(match: string, count: number): AsyncIterable<string> {
    const stream = this.client.scanStream({ match, count });
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<string> => {
        const iter = stream[Symbol.asyncIterator]() as AsyncIterator<string[] | string>;
        let pending: string[] = [];
        return {
          next: async (): Promise<IteratorResult<string>> => {
            for (;;) {
              if (pending.length > 0) {
                const value = pending.shift() as string;
                return { value, done: false };
              }
              const batch = await iter.next();
              if (batch.done) {
                return { value: undefined as unknown as string, done: true };
              }
              const next = batch.value;
              pending = Array.isArray(next) ? [...next] : [next];
            }
          },
        };
      },
    };
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    return this.client.eval(script, keys.length, ...keys, ...args);
  }

  pipeline(): RedisDriverPipeline {
    return new IoredisPipeline(this.client.pipeline());
  }

  multi(): RedisDriverPipeline {
    return new IoredisPipeline(this.client.multi());
  }

  async close(): Promise<void> {
    await quitThenDisconnect(this.client, this.label);
  }
}

// Builds a fresh Redis per call — RedisClient owns the driver cache; must NOT cache here.
export function createIoredisDriverFactory(config: RedisConfig, label = 'redis:unlabelled'): RedisDriverFactory {
  return async (): Promise<RedisDriver> => {
    const options = buildRedisOptions(config);
    const client = new Redis(options);
    client.on('error', (error: unknown) => {
      void error;
    });
    // re-stamped per connect: ioredis builds a fresh socket on every reconnect.
    client.on('connect', () => labelRedisStream(client.stream, label));
    return new IoredisDriver(client, label);
  };
}

export { RedisConnectionError };
