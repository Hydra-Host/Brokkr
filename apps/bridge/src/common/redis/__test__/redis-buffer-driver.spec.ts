import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RESULT_PUBSUB_TIMEOUT } from '../../../agent/result-publisher/result-publisher.service';

import { buildBufferRedisDriver } from '../redis-buffer-driver';

const h = vi.hoisted(() => {
  class FakePipe {
    readonly ops: unknown[][] = [];
    result: Array<[Error | null, unknown]> | null = [];
    set(...a: unknown[]): this {
      this.ops.push(['set', ...a]);
      return this;
    }
    publish(...a: unknown[]): this {
      this.ops.push(['publish', ...a]);
      return this;
    }
    hset(...a: unknown[]): this {
      this.ops.push(['hset', ...a]);
      return this;
    }
    expire(...a: unknown[]): this {
      this.ops.push(['expire', ...a]);
      return this;
    }
    rpush(...a: unknown[]): this {
      this.ops.push(['rpush', ...a]);
      return this;
    }
    async exec(): Promise<Array<[Error | null, unknown]> | null> {
      return this.result;
    }
  }

  class FakeRedis {
    readonly buffers = new Map<string, Buffer>();
    readonly hashes = new Map<string, Record<string, string>>();
    readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    readonly subscribed: string[] = [];
    readonly pipe = new FakePipe();
    quitCalls = 0;
    disconnectCalls = 0;

    constructor(..._args: unknown[]) {
      h.instances.push(this);
    }
    on(event: string, fn: (...args: unknown[]) => void): this {
      const list = this.listeners.get(event) ?? [];
      list.push(fn);
      this.listeners.set(event, list);
      return this;
    }
    emit(event: string, ...args: unknown[]): void {
      for (const fn of this.listeners.get(event) ?? []) fn(...args);
    }
    async getBuffer(key: string): Promise<Buffer | null> {
      return this.buffers.get(key) ?? null;
    }
    async hgetall(key: string): Promise<Record<string, string>> {
      return this.hashes.get(key) ?? {};
    }
    async set(): Promise<'OK'> {
      return 'OK';
    }
    pipeline(): FakePipe {
      return this.pipe;
    }
    duplicate(): FakeRedis {
      return new FakeRedis();
    }
    async subscribe(channel: string): Promise<void> {
      this.subscribed.push(channel);
    }
    async unsubscribe(): Promise<void> {}
    async quit(): Promise<'OK'> {
      this.quitCalls += 1;
      return 'OK';
    }
    disconnect(): void {
      this.disconnectCalls += 1;
    }
  }

  return { FakeRedis, instances: [] as InstanceType<typeof FakeRedis>[] };
});

vi.mock('ioredis', () => ({ Redis: h.FakeRedis }));

describe('buildBufferRedisDriver', () => {
  beforeEach(() => {
    h.instances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('get returns raw Buffer bytes via getBuffer (a UTF-8 decode would corrupt proto payloads)', async () => {
    const driver = buildBufferRedisDriver();
    const client = h.instances[0];
    const bytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
    client.buffers.set('results:device:42', bytes);

    const got = await driver.get('results:device:42');
    expect(Buffer.isBuffer(got)).toBe(true);
    expect(got).toEqual(bytes);
  });

  it('hgetall returns hash fields', async () => {
    const driver = buildBufferRedisDriver();
    const client = h.instances[0];
    client.hashes.set('work:progress:42', { progress: '0.5', message: 'half done' });

    await expect(driver.hgetall('work:progress:42')).resolves.toEqual({
      progress: '0.5',
      message: 'half done',
    });
  });

  it('pipeline flattens ioredis [err, result][] into plain results', async () => {
    const driver = buildBufferRedisDriver();
    const client = h.instances[0];
    client.pipe.result = [
      [null, 'OK'],
      [null, 1],
    ];

    const results = await driver.pipeline().set('k', Buffer.from('v'), 30).publish('chan', 'ping').exec();

    expect(results).toEqual(['OK', 1]);
    expect(client.pipe.ops[0]).toEqual(['set', 'k', Buffer.from('v'), 'EX', 30]);
  });

  it('pipeline exec throws when ioredis returns null (MULTI/pipeline aborted)', async () => {
    const driver = buildBufferRedisDriver();
    h.instances[0].pipe.result = null;

    await expect(driver.pipeline().set('k', 'v', 30).exec()).rejects.toThrow(/aborted/);
  });

  it('subscribePubSub uses a dedicated (duplicated) connection and delivers binary messages', async () => {
    const driver = buildBufferRedisDriver();
    const pubsub = driver.subscribePubSub();
    expect(h.instances).toHaveLength(2);
    const sub = h.instances[1];

    await pubsub.subscribe('results:channel');
    expect(sub.subscribed).toEqual(['results:channel']);

    const payload = Buffer.from([0x01, 0x02, 0xfe]);
    sub.emit('messageBuffer', Buffer.from('results:channel'), payload);

    const msg = await pubsub.getMessage(1000, 2000);
    if (msg === null || msg === RESULT_PUBSUB_TIMEOUT) throw new Error('expected a delivered message');
    expect(msg.data).toEqual(payload);
  });

  it('getMessage resolves null when close() wakes a parked waiter', async () => {
    const driver = buildBufferRedisDriver();
    const pubsub = driver.subscribePubSub();
    await pubsub.subscribe('results:channel');

    const pending = pubsub.getMessage(60_000, 120_000);
    await pubsub.close();
    expect(await pending).toBeNull();
    expect(h.instances[1].quitCalls).toBe(1);
  });

  it('getMessage resolves null on the inner per-poll deadline', async () => {
    vi.useFakeTimers();
    const driver = buildBufferRedisDriver();
    const pubsub = driver.subscribePubSub();
    await pubsub.subscribe('results:channel');

    const pending = pubsub.getMessage(50, 100);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBeNull();
  });

  it('getMessage resolves the timeout sentinel when the outer deadline fires first', async () => {
    vi.useFakeTimers();
    const driver = buildBufferRedisDriver();
    const pubsub = driver.subscribePubSub();
    await pubsub.subscribe('results:channel');

    const pending = pubsub.getMessage(100, 50);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toBe(RESULT_PUBSUB_TIMEOUT);
  });

  it('close quits and disconnects the main client', async () => {
    const driver = buildBufferRedisDriver();
    const client = h.instances[0];

    await driver.close();

    expect(client.quitCalls).toBe(1);
    expect(client.disconnectCalls).toBe(1);
  });

  it('close also reclaims a subscriber connection whose wrapper was never closed', async () => {
    const driver = buildBufferRedisDriver();
    driver.subscribePubSub();
    const client = h.instances[0];
    const sub = h.instances[1];

    await driver.close();

    expect(sub.quitCalls).toBe(1);
    expect(sub.disconnectCalls).toBe(1);
    expect(client.disconnectCalls).toBe(1);
  });

  it('close does not re-quit a subscriber the wrapper already closed', async () => {
    const driver = buildBufferRedisDriver();
    const pubsub = driver.subscribePubSub();
    const sub = h.instances[1];

    await pubsub.close();
    await driver.close();

    expect(sub.quitCalls).toBe(1);
    expect(sub.disconnectCalls).toBe(0);
  });
});
