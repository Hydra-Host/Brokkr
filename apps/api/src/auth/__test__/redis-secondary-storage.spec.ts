import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => {
  const store = new Map<string, string>();
  const setCalls: Array<unknown[]> = [];
  const delCalls: string[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let quitCalls = 0;
  class FakeRedis {
    on(event: string, handler: (...args: unknown[]) => void): this {
      listeners.set(event, handler);
      return this;
    }
    async get(key: string): Promise<string | null> {
      return store.has(key) ? (store.get(key) ?? null) : null;
    }
    async set(key: string, value: string, ...rest: unknown[]): Promise<'OK'> {
      setCalls.push([key, value, ...rest]);
      store.set(key, value);
      return 'OK';
    }
    async del(key: string): Promise<number> {
      delCalls.push(key);
      return store.delete(key) ? 1 : 0;
    }
    async quit(): Promise<'OK'> {
      quitCalls += 1;
      return 'OK';
    }
  }
  return {
    store,
    setCalls,
    delCalls,
    listeners,
    getQuitCalls: () => quitCalls,
    resetQuitCalls: () => {
      quitCalls = 0;
    },
    FakeRedis,
  };
});

vi.mock('ioredis', () => ({ default: mock.FakeRedis }));

import { createRedisSecondaryStorage } from '../redis-secondary-storage';

describe('createRedisSecondaryStorage', () => {
  const originalUrl = process.env.REDIS_URL;
  const originalDisableFlag = process.env.DISABLE_AUTH_SESSION_CACHE;
  const originalNodeEnv = process.env.NODE_ENV;

  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  beforeEach(() => {
    process.env.REDIS_URL = 'redis://localhost:6379';
    delete process.env.DISABLE_AUTH_SESSION_CACHE;
    mock.store.clear();
    mock.setCalls.length = 0;
    mock.delCalls.length = 0;
    mock.listeners.clear();
    mock.resetQuitCalls();
  });

  afterEach(() => {
    restore('REDIS_URL', originalUrl);
    restore('DISABLE_AUTH_SESSION_CACHE', originalDisableFlag);
    restore('NODE_ENV', originalNodeEnv);
  });

  it('returns undefined when REDIS_URL is not configured (Better Auth falls back to DB storage)', () => {
    delete process.env.REDIS_URL;
    expect(createRedisSecondaryStorage()).toBeUndefined();
  });

  it('returns undefined when DISABLE_AUTH_SESSION_CACHE is set outside production', () => {
    process.env.DISABLE_AUTH_SESSION_CACHE = 'true';
    process.env.NODE_ENV = 'development';
    expect(createRedisSecondaryStorage()).toBeUndefined();
  });

  it('ignores DISABLE_AUTH_SESSION_CACHE in production (kill-switch)', () => {
    process.env.DISABLE_AUTH_SESSION_CACHE = 'true';
    process.env.NODE_ENV = 'production';
    expect(createRedisSecondaryStorage()).toBeDefined();
  });

  it('registers an error listener so ioredis connection errors never become uncaught exceptions', () => {
    createRedisSecondaryStorage();
    const handler = mock.listeners.get('error');
    expect(handler).toBeTypeOf('function');
    expect(() => handler!(new Error('ECONNREFUSED'))).not.toThrow();
  });

  it('get parses JSON payloads and returns the raw string when the value is not JSON', async () => {
    const handle = createRedisSecondaryStorage();
    expect(handle).toBeDefined();
    mock.store.set('session:json', '{"userId":"u1"}');
    mock.store.set('session:raw', 'opaque-token');

    expect(await handle!.storage.get('session:json')).toEqual({ userId: 'u1' });
    expect(await handle!.storage.get('session:raw')).toBe('opaque-token');
  });

  it('get returns null for a missing key', async () => {
    const handle = createRedisSecondaryStorage();
    expect(await handle!.storage.get('absent')).toBeNull();
  });

  it('set uses SET ... EX with the ttl when given, and a plain SET otherwise', async () => {
    const handle = createRedisSecondaryStorage();
    await handle!.storage.set('rate:u1', 'count', 60);
    await handle!.storage.set('rate:u2', 'count');

    expect(mock.setCalls).toContainEqual(['rate:u1', 'count', 'EX', 60]);
    expect(mock.setCalls).toContainEqual(['rate:u2', 'count']);
  });

  it('delete removes the key', async () => {
    const handle = createRedisSecondaryStorage();
    mock.store.set('session:gone', 'x');
    await handle!.storage.delete('session:gone');

    expect(mock.delCalls).toEqual(['session:gone']);
    expect(mock.store.has('session:gone')).toBe(false);
  });

  it('close quits the underlying ioredis client so it is released on shutdown', async () => {
    const handle = createRedisSecondaryStorage();
    await handle!.close();
    expect(mock.getQuitCalls()).toBe(1);
  });
});
