import type { RedisLeaseCache } from '../redis-lease-store.js';

export class FakeRedisLeaseCache implements RedisLeaseCache {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number | undefined>();

  async get(key: string): Promise<string | null> {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  async set(key: string, value: string, ttl?: number): Promise<unknown> {
    this.store.set(key, value);
    this.ttls.set(key, ttl);
    return 'OK';
  }

  async delete(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }

  async scan(pattern: string): Promise<string[]> {
    if (!pattern.endsWith('*')) {
      return this.store.has(pattern) ? [pattern] : [];
    }
    const prefix = pattern.slice(0, -1);
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }
}

export class RejectingRedisLeaseCache implements RedisLeaseCache {
  constructor(private readonly error = new Error('redis down')) {}

  async get(): Promise<string | null> {
    throw this.error;
  }

  async set(): Promise<unknown> {
    throw this.error;
  }

  async delete(): Promise<number> {
    throw this.error;
  }

  async scan(): Promise<string[]> {
    throw this.error;
  }
}
