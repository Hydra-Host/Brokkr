// Not the shared RedisClient: WorkResponse payloads are binary proto bytes, so `get` must return a Buffer; no key-prefixing — result-publisher keys already carry the zone prefix.

import { readFileSync } from 'node:fs';

import { Redis, type RedisOptions } from 'ioredis';

import type {
  ResultPubSub,
  ResultPubSubMessage,
  ResultPubSubTimeout,
} from '../../agent/result-publisher/result-publisher.service';
import { RESULT_PUBSUB_TIMEOUT } from '../../agent/result-publisher/result-publisher.service';
import { logDebug } from '../../logger/logger.service';

import type { BufferAwareDriverPipeline, BufferAwareRedisDriver } from './redis-buffer-adapter';
import { loadRedisConfig, type RedisConfig } from './redis-client';
import { labelRedisStream } from './redis-handle-label';
import { quitThenDisconnect } from './redis-teardown';

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

function attachErrorGuard(client: Redis, label: string): Redis {
  client.on('error', (error: unknown) => {
    void error;
  });
  // re-stamped per connect: ioredis builds a fresh socket on every reconnect.
  client.on('connect', () => labelRedisStream(client.stream, label));
  return client;
}

class IoredisBufferPipeline implements BufferAwareDriverPipeline {
  private readonly pipe: ReturnType<Redis['pipeline']>;

  constructor(pipe: ReturnType<Redis['pipeline']>) {
    this.pipe = pipe;
  }

  set(key: string, value: string | Buffer, exSeconds: number): BufferAwareDriverPipeline {
    this.pipe.set(key, value, 'EX', exSeconds);
    return this;
  }

  publish(channel: string, message: string): BufferAwareDriverPipeline {
    this.pipe.publish(channel, message);
    return this;
  }

  hset(key: string, fields: Record<string, string>): BufferAwareDriverPipeline {
    this.pipe.hset(key, fields);
    return this;
  }

  expire(key: string, seconds: number): BufferAwareDriverPipeline {
    this.pipe.expire(key, seconds);
    return this;
  }

  rpush(key: string, value: string | Buffer): BufferAwareDriverPipeline {
    this.pipe.rpush(key, value);
    return this;
  }

  async exec(): Promise<unknown[]> {
    const results = await this.pipe.exec();
    if (results === null) {
      throw new Error('buffer-redis pipeline exec aborted (null result)');
    }
    const flattened: unknown[] = [];
    for (const [err, value] of results) {
      if (err) throw err;
      flattened.push(value);
    }
    return flattened;
  }
}

class IoredisResultPubSub implements ResultPubSub {
  private readonly sub: Redis;
  private readonly onClosed: () => void;
  private readonly queue: ResultPubSubMessage[] = [];
  private waiter: ((value: ResultPubSubMessage | null | ResultPubSubTimeout) => void) | null = null;
  private closed = false;

  constructor(sub: Redis, onClosed: () => void = () => undefined) {
    this.sub = sub;
    this.onClosed = onClosed;
    this.sub.on('messageBuffer', (_channel: Buffer, message: Buffer) => {
      this.deliver({ data: message });
    });
  }

  private deliver(msg: ResultPubSubMessage): void {
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  async subscribe(channel: string): Promise<void> {
    await this.sub.subscribe(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    await this.sub.unsubscribe(channel);
  }

  async close(): Promise<void> {
    this.closed = true;
    // Wake any parked waiter so the caller's loop doesn't hang on a dead connection.
    if (this.waiter) {
      const resolve = this.waiter;
      this.waiter = null;
      resolve(null);
    }
    try {
      await this.sub.quit();
    } catch {
      try {
        this.sub.disconnect();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        void logDebug(`Result pubsub disconnect failed during close: ${message}`);
      }
    } finally {
      this.onClosed();
    }
  }

  getMessage(
    innerTimeoutMs: number,
    outerTimeoutMs: number,
  ): Promise<ResultPubSubMessage | null | ResultPubSubTimeout> {
    const buffered = this.queue.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (this.closed) return Promise.resolve(null);
    if (this.waiter) return Promise.resolve(null);

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: ResultPubSubMessage | null | ResultPubSubTimeout): void => {
        if (settled) return;
        settled = true;
        clearTimeout(innerTimer);
        clearTimeout(outerTimer);
        if (this.waiter === waiterFn) this.waiter = null;
        resolve(value);
      };

      const waiterFn = (msg: ResultPubSubMessage | null | ResultPubSubTimeout): void => finish(msg);
      this.waiter = waiterFn;

      const innerTimer = setTimeout(() => finish(null), Math.max(0, innerTimeoutMs));
      // outer: overall hang → sentinel; caller re-checks the result key for a missed publish
      const outerTimer = setTimeout(() => finish(RESULT_PUBSUB_TIMEOUT), Math.max(0, outerTimeoutMs));
    });
  }
}

class IoredisBufferDriver implements BufferAwareRedisDriver {
  private readonly client: Redis;
  private readonly config: RedisConfig;
  // subscriber duplicates outlive their wrapper when result-publisher's cleanup times out
  // ("leaking connection"); tracking them lets shutdown reclaim the stragglers.
  private readonly subscribers = new Set<Redis>();

  constructor(client: Redis, config: RedisConfig) {
    this.client = client;
    this.config = config;
  }

  async set(key: string, value: string | Buffer, exSeconds: number): Promise<unknown> {
    return this.client.set(key, value, 'EX', exSeconds);
  }

  async get(key: string): Promise<Buffer | null> {
    return this.client.getBuffer(key);
  }

  async del(key: string): Promise<number> {
    return this.client.del(key);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return this.client.hgetall(key);
  }

  pipeline(): BufferAwareDriverPipeline {
    return new IoredisBufferPipeline(this.client.pipeline());
  }

  subscribePubSub(): ResultPubSub {
    const sub = attachErrorGuard(this.client.duplicate(), 'buffer-redis:sub');
    this.subscribers.add(sub);
    return new IoredisResultPubSub(sub, () => this.subscribers.delete(sub));
  }

  async close(): Promise<void> {
    const subs = [...this.subscribers];
    this.subscribers.clear();
    for (const sub of subs) {
      await quitThenDisconnect(sub, 'buffer-redis:sub');
    }
    await quitThenDisconnect(this.client, 'buffer-redis:main');
  }
}

export function buildBufferRedisDriver(config: RedisConfig = loadRedisConfig()): BufferAwareRedisDriver {
  const client = attachErrorGuard(new Redis(buildRedisOptions(config)), 'buffer-redis:main');
  return new IoredisBufferDriver(client, config);
}
