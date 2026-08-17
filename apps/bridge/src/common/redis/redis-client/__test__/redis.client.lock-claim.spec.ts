import { describe, expect, it } from 'vitest';

import type { RedisDriver, RedisDriverPipeline } from '../redis-driver';
import { RedisClient } from '../redis.client';
import type { RedisConfig } from '../redis.config';

const CONFIG: RedisConfig = {
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
};

class ClaimDriver implements RedisDriver {
  constructor(
    private readonly store: Map<string, string>,
    private readonly state: { failNextEval: boolean },
  ) {}

  async ping(): Promise<unknown> {
    return 'PONG';
  }

  async eval(script: string, keys: string[], args: string[]): Promise<unknown> {
    const key = keys[0];
    const expectedValue = args[0];
    const existing = this.store.get(key);
    let result = 0;
    if (script.includes('"set"')) {
      const claimed = existing === undefined;
      if (claimed) this.store.set(key, expectedValue);
      result = claimed || existing === expectedValue ? 1 : 0;
    } else if (script.includes('"expire"')) {
      result = existing === expectedValue ? 1 : 0;
    } else if (existing === expectedValue) {
      this.store.delete(key);
      result = 1;
    }
    if (this.state.failNextEval) {
      this.state.failNextEval = false;
      throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    }
    return result;
  }

  async close(): Promise<void> {}

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return 'OK';
  }
  async setex(): Promise<unknown> {
    throw new Error('not used');
  }
  async setNx(): Promise<boolean> {
    throw new Error('not used');
  }
  async del(): Promise<number> {
    throw new Error('not used');
  }
  async exists(): Promise<number> {
    throw new Error('not used');
  }
  async rpush(): Promise<number> {
    throw new Error('not used');
  }
  async lrange(): Promise<string[]> {
    throw new Error('not used');
  }
  async expire(): Promise<number> {
    throw new Error('not used');
  }
  async hset(): Promise<number> {
    throw new Error('not used');
  }
  async hget(): Promise<string | null> {
    throw new Error('not used');
  }
  async hgetall(): Promise<Record<string, string>> {
    throw new Error('not used');
  }
  scanMatch(): AsyncIterable<string> {
    throw new Error('not used');
  }
  pipeline(): RedisDriverPipeline {
    throw new Error('not used');
  }
  multi(): RedisDriverPipeline {
    throw new Error('not used');
  }
}

describe('RedisClient.acquireLock idempotent claim', () => {
  it('returns the token (not null) when the first claim commits but the reply is lost on reconnect', async () => {
    const store = new Map<string, string>();
    const state = { failNextEval: true };
    const client = new RedisClient(CONFIG, async () => new ClaimDriver(store, state));

    const token = await client.acquireLock('device:42', 60);

    expect(token).not.toBeNull();
    expect(store.get('lock:device:42')).toBe(token);
  });

  it('still denies a second holder (mutual exclusion preserved)', async () => {
    const store = new Map<string, string>();
    const state = { failNextEval: false };
    const client = new RedisClient(CONFIG, async () => new ClaimDriver(store, state));

    const first = await client.acquireLock('device:42', 60);
    const second = await client.acquireLock('device:42', 60);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('stores and returns the complete holder payload with a generated ownership token', async () => {
    const store = new Map<string, string>();
    const client = new RedisClient(CONFIG, async () => new ClaimDriver(store, { failNextEval: false }));

    const value = await client.acquireLock('device:42', 60, 'job-123', {
      saga_name: 'provision',
      plan_id: 'plan-123',
      token: 'untrusted-token',
    });

    expect(value).not.toBeNull();
    expect(store.get('lock:device:42')).toBe(value);
    if (value === null) throw new Error('expected lock acquisition to succeed');
    const parsed: unknown = JSON.parse(value);
    expect(parsed).toEqual({
      saga_name: 'provision',
      plan_id: 'plan-123',
      token: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
  });

  it('uses the complete opaque holder payload for renewal, release, and deletion', async () => {
    const store = new Map<string, string>();
    const client = new RedisClient(CONFIG, async () => new ClaimDriver(store, { failNextEval: false }));
    const value = await client.acquireLock('device:renew', 60, '', { plan_id: 'plan-123' });
    if (value === null) throw new Error('expected lock acquisition to succeed');
    const info = await client.readLockInfo('device:renew');
    if (info === null) throw new Error('expected lock info');

    expect(await client.renewLockIfOwner('device:renew', info.token, 60)).toBe(false);
    expect(await client.renewLockIfOwner('device:renew', value, 60)).toBe(true);
    expect(await client.releaseLock('device:renew', value)).toBe(true);

    const deleteValue = await client.acquireLock('device:delete', 60, '', { plan_id: 'plan-456' });
    if (deleteValue === null) throw new Error('expected lock acquisition to succeed');
    expect(await client.deleteIfOwner('lock:device:delete', deleteValue)).toBe(true);
  });
});

describe('RedisClient.readLockInfo', () => {
  it('parses serialized holder metadata', async () => {
    const store = new Map<string, string>();
    const client = new RedisClient(CONFIG, async () => new ClaimDriver(store, { failNextEval: false }));
    const payload = JSON.stringify({ token: 'abc-123', saga_name: 'provision', plan_id: 'plan-123' });
    store.set('lock:device:42', payload);

    await expect(client.readLockInfo('device:42')).resolves.toEqual({
      token: 'abc-123',
      saga_name: 'provision',
      plan_id: 'plan-123',
    });
  });

  it('wraps bare and invalid holder values as opaque tokens', async () => {
    const store = new Map<string, string>();
    const client = new RedisClient(CONFIG, async () => new ClaimDriver(store, { failNextEval: false }));
    store.set('lock:device:bare', 'bare-uuid-value');
    const invalidPayload = JSON.stringify({ saga_name: 'provision' });
    store.set('lock:device:invalid', invalidPayload);

    await expect(client.readLockInfo('device:bare')).resolves.toEqual({ token: 'bare-uuid-value' });
    await expect(client.readLockInfo('device:invalid')).resolves.toEqual({ token: invalidPayload });
  });

  it('returns null when the lock is absent', async () => {
    const store = new Map<string, string>();
    const client = new RedisClient(CONFIG, async () => new ClaimDriver(store, { failNextEval: false }));

    await expect(client.readLockInfo('device:missing')).resolves.toBeNull();
  });
});
