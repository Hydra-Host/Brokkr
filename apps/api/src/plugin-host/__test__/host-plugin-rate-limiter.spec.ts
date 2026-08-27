import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.unmock('ioredis');

import Redis from 'ioredis';

import { createPluginRateLimiter } from '../host-plugin-rate-limiter';

const request = {
  name: 'anonymous writes',
  subject: '203.0.113.1',
  limit: 10,
  windowSeconds: 60,
};

function makeRaw(result: unknown = [1, 60]) {
  return { eval: vi.fn().mockResolvedValue(result) };
}

function redisUrl(): string {
  return process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
}

function luaCase() {
  const subject = `203.0.113.1:${randomUUID()}`;
  return {
    request: { ...request, subject },
    key: `plugin:bid-ask:rate-limit:anonymous%20writes:${encodeURIComponent(subject)}`,
  };
}

async function probeRedis(): Promise<boolean> {
  const probe = new Redis(redisUrl(), {
    connectTimeout: 1_000,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

describe('createPluginRateLimiter', () => {
  it('consumes an atomic fixed window in the plugin namespace', async () => {
    const raw = makeRaw();
    const limiter = createPluginRateLimiter(raw, 'bid-ask');

    await expect(limiter.consume(request)).resolves.toEqual({
      allowed: true,
      remaining: 9,
      retryAfterSeconds: 60,
    });
    expect(raw.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('INCR', KEYS[1])"),
      1,
      'plugin:bid-ask:rate-limit:anonymous%20writes:203.0.113.1',
      60,
    );
    expect(raw.eval.mock.calls[0]?.[0]).toContain('tonumber(ARGV[1])');
  });

  it('rejects counts above the policy limit', async () => {
    const limiter = createPluginRateLimiter(makeRaw([11, 42]), 'bid-ask');

    await expect(limiter.consume(request)).resolves.toEqual({
      allowed: false,
      remaining: 0,
      retryAfterSeconds: 42,
    });
  });

  it('allows the request that reaches the policy limit', async () => {
    const limiter = createPluginRateLimiter(makeRaw([10, 42]), 'bid-ask');

    await expect(limiter.consume(request)).resolves.toEqual({
      allowed: true,
      remaining: 0,
      retryAfterSeconds: 42,
    });
  });

  it('propagates Redis eval failures', async () => {
    const raw = { eval: vi.fn().mockRejectedValue(new Error('redis unavailable')) };
    const limiter = createPluginRateLimiter(raw, 'bid-ask');

    await expect(limiter.consume(request)).rejects.toThrow('redis unavailable');
  });

  it('isolates the same policy and subject between plugins', async () => {
    const raw = makeRaw();

    await createPluginRateLimiter(raw, 'hubspot-leads').consume(request);
    await createPluginRateLimiter(raw, 'salesforce-leads').consume(request);

    expect(raw.eval.mock.calls.map((call) => call[2])).toEqual([
      'plugin:hubspot-leads:rate-limit:anonymous%20writes:203.0.113.1',
      'plugin:salesforce-leads:rate-limit:anonymous%20writes:203.0.113.1',
    ]);
  });

  it('rejects invalid requests before accessing Redis', async () => {
    const raw = makeRaw();
    const limiter = createPluginRateLimiter(raw, 'bid-ask');

    await expect(limiter.consume({ ...request, limit: 0 })).rejects.toThrow('Plugin rate limit request is invalid');
    expect(raw.eval).not.toHaveBeenCalled();
  });

  it('rejects malformed Redis results', async () => {
    const limiter = createPluginRateLimiter(makeRaw(['bad']), 'bid-ask');

    await expect(limiter.consume(request)).rejects.toThrow();
  });
});

describe('createPluginRateLimiter Lua consume script', () => {
  const keys: string[] = [];
  let redis: Redis | undefined;

  beforeAll(async () => {
    if (!(await probeRedis())) return;
    redis = new Redis(redisUrl(), { maxRetriesPerRequest: 0 });
    redis.on('error', () => {});
  });

  function requireRedis(skip: (reason?: string) => void): Redis {
    if (!redis) {
      skip('Redis is not available');
      throw new Error('unreachable');
    }
    return redis;
  }

  afterEach(async () => {
    if (!redis || keys.length === 0) return;
    await redis.del(...keys);
    keys.length = 0;
  });

  afterAll(() => {
    redis?.disconnect();
  });

  it('sets EXPIRE on the first consume (count == 1)', async ({ skip }) => {
    const client = requireRedis(skip);
    const limiter = createPluginRateLimiter(client, 'bid-ask');
    const { request: req, key } = luaCase();
    keys.push(key);

    await expect(limiter.consume(req)).resolves.toEqual({
      allowed: true,
      remaining: 9,
      retryAfterSeconds: expect.any(Number),
    });
    expect(await client.get(key)).toBe('1');
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(req.windowSeconds);
  });

  it('does not reset EXPIRE on later consumes (count > 1)', async ({ skip }) => {
    const client = requireRedis(skip);
    const limiter = createPluginRateLimiter(client, 'bid-ask');
    const { request: req, key } = luaCase();
    keys.push(key);

    await limiter.consume(req);
    expect(await client.expire(key, 12)).toBe(1);
    const ttlBefore = await client.ttl(key);

    await expect(limiter.consume(req)).resolves.toEqual({
      allowed: true,
      remaining: 8,
      retryAfterSeconds: expect.any(Number),
    });
    expect(await client.get(key)).toBe('2');
    const ttlAfter = await client.ttl(key);
    expect(ttlAfter).toBeGreaterThan(0);
    expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);
    expect(ttlAfter).toBeLessThan(req.windowSeconds);
  });

  it('sets fallback EXPIRE when the key has no TTL (ttl < 0)', async ({ skip }) => {
    const client = requireRedis(skip);
    const limiter = createPluginRateLimiter(client, 'bid-ask');
    const { request: req, key } = luaCase();
    keys.push(key);
    await client.set(key, '4');
    expect(await client.ttl(key)).toBe(-1);

    await expect(limiter.consume(req)).resolves.toEqual({
      allowed: true,
      remaining: 5,
      retryAfterSeconds: req.windowSeconds,
    });
    expect(await client.get(key)).toBe('5');
    const ttl = await client.ttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(req.windowSeconds);
  });
});
