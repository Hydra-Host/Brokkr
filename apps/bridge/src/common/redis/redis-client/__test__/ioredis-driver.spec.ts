import { describe, expect, it, vi } from 'vitest';

class FakePipeline {
  private readonly client: InMemoryIoredis;
  private readonly ops: Array<() => unknown> = [];

  constructor(client: InMemoryIoredis) {
    this.client = client;
  }

  hset(key: string, mapping: Record<string, string>): this {
    this.ops.push(() => this.client.hset(key, mapping));
    return this;
  }

  expire(key: string, seconds: number): this {
    this.ops.push(() => this.client.expire(key, seconds));
    return this;
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    const out: Array<[Error | null, unknown]> = [];
    for (const op of this.ops) {
      try {
        out.push([null, await op()]);
      } catch (error) {
        out.push([error as Error, null]);
      }
    }
    return out;
  }
}

class InMemoryIoredis {
  private readonly store = new Map<string, string>();
  private readonly hashes = new Map<string, Map<string, string>>();
  private readonly listeners = new Map<string, Array<(value: unknown) => void>>();

  on(event: string, listener: (value: unknown) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    (this.listeners.get(event) as Array<(value: unknown) => void>).push(listener);
    return this;
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(...args: unknown[]): Promise<string | null> {
    const [key, value, ...rest] = args as [string, string, ...string[]];
    if (rest.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }

  async setex(key: string, _ttl: number, value: string): Promise<string> {
    this.store.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const had = this.store.delete(key) || this.hashes.delete(key);
    return had ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    return this.store.has(key) || this.hashes.has(key) ? 1 : 0;
  }

  async expire(_key: string, _seconds: number): Promise<number> {
    return 1;
  }

  async hset(key: string, mapping: Record<string, string>): Promise<number> {
    const existing = this.hashes.get(key) ?? new Map<string, string>();
    let added = 0;
    for (const [k, v] of Object.entries(mapping)) {
      if (!existing.has(k)) added += 1;
      existing.set(k, v);
    }
    this.hashes.set(key, existing);
    return added;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const map = this.hashes.get(key);
    if (!map) return {};
    return Object.fromEntries(map.entries());
  }

  async eval(script: string, numKeys: number, ...rest: string[]): Promise<unknown> {
    const keys = rest.slice(0, numKeys);
    const args = rest.slice(numKeys);
    const key = keys[0] as string;
    const expected = args[0] as string;
    const current = this.store.get(key);
    if (script.includes('expire')) {
      return current === expected ? 1 : 0;
    }
    if (script.includes('del')) {
      if (current === expected) {
        this.store.delete(key);
        return 1;
      }
      return 0;
    }
    return 0;
  }

  pipeline(): FakePipeline {
    return new FakePipeline(this);
  }

  multi(): FakePipeline {
    return new FakePipeline(this);
  }

  scanStream(_opts: { match: string; count: number }): AsyncIterable<string[]> {
    const keys = Array.from(this.store.keys());
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<string[]> => {
        let yielded = false;
        return {
          next: async (): Promise<IteratorResult<string[]>> => {
            if (yielded) return { value: [], done: true };
            yielded = true;
            return { value: keys, done: false };
          },
        };
      },
    } as AsyncIterable<string[]>;
  }

  async rpush(_key: string, ..._values: string[]): Promise<number> {
    return _values.length;
  }

  async lrange(_key: string, _start: number, _stop: number): Promise<string[]> {
    return [];
  }

  static quitHangs = false;
  static disconnectCalls = 0;

  async quit(): Promise<string> {
    if (InMemoryIoredis.quitHangs) return new Promise<string>(() => {});
    return 'OK';
  }

  disconnect(): void {
    InMemoryIoredis.disconnectCalls += 1;
  }
}

vi.mock('ioredis', () => {
  return {
    Redis: function MockRedis() {
      return new InMemoryIoredis();
    },
  };
});

import { createIoredisDriverFactory } from '../ioredis-driver';
import { RedisClient } from '../redis.client';
import type { RedisConfig } from '../redis.config';

function buildTestConfig(overrides: Partial<RedisConfig> = {}): RedisConfig {
  return {
    url: 'redis://localhost:6379/0',
    host: 'localhost',
    port: 6379,
    username: '',
    password: '',
    db: 0,
    tls: false,
    tlsCaCert: '',
    prefix: '',
    socketTimeout: 5,
    socketConnectTimeout: 5,
    retryOnError: true,
    maxConnections: 50,
    encryptionKey: 'wmjZhYLXlEQTYtwCVFNg1Q4k+5yQEQHLa87eDmf0Tmo=',
    ttls: {
      deviceNetplan: 120,
      bmcCipher: 2_592_000,
      deviceSshIp: 300,
      resolvedIp: 3600,
      deviceInitrd: 600,
      bridgeInterfaces: 300,
      syncVersion: 2_592_000,
    },
    ...overrides,
  };
}

describe('createIoredisDriverFactory', () => {
  it('returns a driver whose methods are real callable functions across the full RedisDriver surface', async () => {
    const factory = createIoredisDriverFactory(buildTestConfig());
    const driver = await factory();
    for (const method of [
      'ping',
      'get',
      'set',
      'setex',
      'setNx',
      'del',
      'exists',
      'rpush',
      'lrange',
      'expire',
      'hset',
      'hget',
      'hgetall',
      'scanMatch',
      'eval',
      'pipeline',
      'close',
    ] as const) {
      expect(typeof driver[method]).toBe('function');
    }
    await expect(driver.ping()).resolves.toBe('PONG');
  });

  it('RedisClient + IoredisDriver round-trip set/get against the in-memory shim', async () => {
    const config = buildTestConfig();
    const client = new RedisClient(config, createIoredisDriverFactory(config));
    await client.set('test', 'value');
    await expect(client.get('test')).resolves.toBe('value');
  });

  it('honors the prefix at the RedisClient layer (driver MUST NOT double-prefix)', async () => {
    const config = buildTestConfig({ prefix: 'zone1' });
    const client = new RedisClient(config, createIoredisDriverFactory(config));
    await client.set('foo', 'bar');
    await expect(client.get('foo')).resolves.toBe('bar');
  });

  it('setNx returns true on first claim and false on duplicate', async () => {
    const config = buildTestConfig();
    const client = new RedisClient(config, createIoredisDriverFactory(config));
    await expect(client.setNx('lock', 'token', 30)).resolves.toBe(true);
    await expect(client.setNx('lock', 'token2', 30)).resolves.toBe(false);
  });

  it('close() force-disconnects promptly even when quit() hangs on a buffered offline queue', async () => {
    InMemoryIoredis.disconnectCalls = 0;
    InMemoryIoredis.quitHangs = true;
    try {
      const driver = await createIoredisDriverFactory(buildTestConfig())();
      await driver.close();
      expect(InMemoryIoredis.disconnectCalls).toBe(1);
    } finally {
      InMemoryIoredis.quitHangs = false;
    }
  });
});
