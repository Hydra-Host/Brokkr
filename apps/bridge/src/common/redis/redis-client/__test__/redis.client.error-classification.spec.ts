import { describe, expect, it } from 'vitest';

import type { RedisDriver, RedisDriverPipeline } from '../redis-driver';
import { RedisClient } from '../redis.client';
import type { RedisConfig } from '../redis.config';
import { RedisOperationError } from '../redis.errors';

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

class FlakyGetDriver implements RedisDriver {
  constructor(private readonly state: { firstError: Error | null }) {}

  async ping(): Promise<unknown> {
    return 'PONG';
  }
  async get(): Promise<string | null> {
    if (this.state.firstError) {
      const err = this.state.firstError;
      this.state.firstError = null;
      throw err;
    }
    return 'value-after-reconnect';
  }
  async close(): Promise<void> {}

  async set(): Promise<unknown> {
    throw new Error('not used');
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
  async xadd(): Promise<string> {
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
  eval(): Promise<unknown> {
    throw new Error('not used');
  }
  pipeline(): RedisDriverPipeline {
    throw new Error('not used');
  }
  multi(): RedisDriverPipeline {
    throw new Error('not used');
  }
}

class FlakySetNxDriver extends FlakyGetDriver {
  private thrown = false;

  override async setNx(): Promise<boolean> {
    if (!this.thrown) {
      this.thrown = true;
      throw new Error('Command timed out');
    }
    return false;
  }
}

describe('RedisClient connection-error classification', () => {
  it("treats a bare 'Command timed out' error as a connection error and reconnects", async () => {
    const state = { firstError: new Error('Command timed out') };
    const client = new RedisClient(CONFIG, async () => new FlakyGetDriver(state));

    await expect(client.get('k')).resolves.toBe('value-after-reconnect');
  });

  it('treats MaxRetriesPerRequestError as a connection error and reconnects', async () => {
    const err = new Error('max retries per request limit reached');
    err.name = 'MaxRetriesPerRequestError';
    const state = { firstError: err };
    const client = new RedisClient(CONFIG, async () => new FlakyGetDriver(state));

    await expect(client.get('k')).resolves.toBe('value-after-reconnect');
  });

  it('does not replay strict setNx on a lost reply — fails loud instead of returning a false negative', async () => {
    const client = new RedisClient(CONFIG, async () => new FlakySetNxDriver({ firstError: null }));

    await expect(client.setNx('claim', 'token', 30)).rejects.toBeInstanceOf(RedisOperationError);
  });
});
