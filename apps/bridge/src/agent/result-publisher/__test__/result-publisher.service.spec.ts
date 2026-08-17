import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DispatchStalled, DispatchTimeout } from '../../dispatch/grpc.exceptions';
import { PARTIAL_KEY_SUFFIX, PROGRESS_KEY_SUFFIX, RESULT_KEY_SUFFIX } from '../result-publisher.keys';
import {
  RESULT_PUBSUB_TIMEOUT,
  ResultPublisherService,
  ResultPublisherTimeoutError,
  type RedisPipeline,
  type ResultPubSub,
  type ResultPubSubMessage,
  type ResultPubSubTimeout,
  type ResultPublisherRedis,
} from '../result-publisher.service';

interface SetRecord {
  value: string | Buffer;
  exSeconds: number;
}

class InMemoryRedis implements ResultPublisherRedis {
  readonly strings = new Map<string, SetRecord>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly lists = new Map<string, Array<string | Buffer>>();
  readonly subscribers = new Set<InMemoryPubSub>();

  async set(key: string, value: string | Buffer, exSeconds: number): Promise<void> {
    this.strings.set(key, { value, exSeconds });
  }

  async get(key: string): Promise<string | Buffer | null> {
    const rec = this.strings.get(key);
    return rec === undefined ? null : rec.value;
  }

  async del(key: string): Promise<number> {
    return this.strings.delete(key) ? 1 : 0;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = this.hashes.get(key);
    return hash === undefined ? {} : Object.fromEntries(hash);
  }

  pipeline(): RedisPipeline {
    const ops: Array<() => void> = [];
    const pipe: RedisPipeline = {
      set: (key, value, exSeconds) => {
        ops.push(() => this.strings.set(key, { value, exSeconds }));
        return pipe;
      },
      publish: (channel, message) => {
        ops.push(() => {
          for (const sub of this.subscribers) sub.deliver(channel, message);
        });
        return pipe;
      },
      hset: (key, fields) => {
        ops.push(() => {
          let h = this.hashes.get(key);
          if (h === undefined) {
            h = new Map();
            this.hashes.set(key, h);
          }
          for (const [k, v] of Object.entries(fields)) h.set(k, v);
        });
        return pipe;
      },
      expire: (_key, _seconds) => {
        ops.push(() => undefined);
        return pipe;
      },
      rpush: (key, value) => {
        ops.push(() => {
          let lst = this.lists.get(key);
          if (lst === undefined) {
            lst = [];
            this.lists.set(key, lst);
          }
          lst.push(value);
        });
        return pipe;
      },
      exec: async () => {
        for (const op of ops) op();
        return [];
      },
    };
    return pipe;
  }

  subscribePubSub(): ResultPubSub {
    return new InMemoryPubSub(this);
  }
}

class InMemoryPubSub implements ResultPubSub {
  private readonly subscribed = new Set<string>();
  private readonly inbox: Array<{ channel: string; message: string }> = [];
  private resolveNext: ((msg: { channel: string; message: string }) => void) | null = null;

  constructor(private readonly hub: InMemoryRedis) {
    hub.subscribers.add(this);
  }

  async subscribe(channel: string): Promise<void> {
    this.subscribed.add(channel);
  }

  async unsubscribe(channel: string): Promise<void> {
    this.subscribed.delete(channel);
  }

  async close(): Promise<void> {
    this.hub.subscribers.delete(this);
  }

  deliver(channel: string, message: string): void {
    if (!this.subscribed.has(channel)) return;
    const env = { channel, message };
    if (this.resolveNext !== null) {
      const r = this.resolveNext;
      this.resolveNext = null;
      r(env);
      return;
    }
    this.inbox.push(env);
  }

  async getMessage(
    innerTimeoutMs: number,
    _outerTimeoutMs: number,
  ): Promise<ResultPubSubMessage | null | ResultPubSubTimeout> {
    if (this.inbox.length > 0) {
      const env = this.inbox.shift() as { channel: string; message: string };
      return { data: env.message };
    }
    return new Promise<ResultPubSubMessage | null>((resolve) => {
      const timer = setTimeout(() => {
        this.resolveNext = null;
        resolve(null);
      }, innerTimeoutMs);
      this.resolveNext = (env) => {
        clearTimeout(timer);
        resolve({ data: env.message });
      };
    });
  }
}

class NeverDeliversPubSub implements ResultPubSub {
  async subscribe(_channel: string): Promise<void> {}
  async unsubscribe(_channel: string): Promise<void> {}
  async close(): Promise<void> {}
  getMessage(innerTimeoutMs: number, _outerTimeoutMs: number): Promise<ResultPubSubMessage | null> {
    return new Promise((resolve) => setTimeout(() => resolve(null), innerTimeoutMs));
  }
}

class DroppingPubSubRedis extends InMemoryRedis {
  override subscribePubSub(): ResultPubSub {
    return new NeverDeliversPubSub();
  }
}

class ScriptedPubSub implements ResultPubSub {
  unsubscribed = false;
  closed = false;
  getMessageCalls = 0;

  constructor(
    private readonly script: Array<ResultPubSubTimeout | { data: string }>,
    private readonly pollDelayMs = 0,
  ) {}

  async subscribe(_channel: string): Promise<void> {}
  async unsubscribe(_channel: string): Promise<void> {
    this.unsubscribed = true;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  async getMessage(
    _innerTimeoutMs: number,
    _outerTimeoutMs: number,
  ): Promise<ResultPubSubMessage | null | ResultPubSubTimeout> {
    this.getMessageCalls += 1;
    if (this.pollDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pollDelayMs));
    const next = this.script.shift();
    if (next === undefined) return RESULT_PUBSUB_TIMEOUT;
    return next;
  }
}

class ScriptedPubSubRedis extends InMemoryRedis {
  constructor(private readonly scripted: ScriptedPubSub) {
    super();
  }
  override subscribePubSub(): ResultPubSub {
    return this.scripted;
  }
}

class HangingCleanupPubSub implements ResultPubSub {
  async subscribe(_channel: string): Promise<void> {}
  unsubscribe(_channel: string): Promise<void> {
    return new Promise<void>(() => {});
  }
  async close(): Promise<void> {}
  async getMessage(): Promise<ResultPubSubMessage | null | ResultPubSubTimeout> {
    return RESULT_PUBSUB_TIMEOUT;
  }
}

class HangingCleanupRedis extends InMemoryRedis {
  override subscribePubSub(): ResultPubSub {
    return new HangingCleanupPubSub();
  }
}

function makePub(zonePrefix = ''): { pub: ResultPublisherService; redis: InMemoryRedis } {
  const redis = new InMemoryRedis();
  const pub = new ResultPublisherService(redis, zonePrefix);
  return { pub, redis };
}

describe('ResultPublisherService', () => {
  let redis: InMemoryRedis;
  let pub: ResultPublisherService;

  beforeEach(() => {
    ({ pub, redis } = makePub());
  });

  it('publish + await_result fast path returns persisted bytes', async () => {
    const payload = Buffer.from('result-bytes-fast');
    await pub.publishResult('wid-fast', payload);
    const got = await pub.awaitResult('wid-fast', 1000);
    expect(got.equals(payload)).toBe(true);
  });

  it('publish-after-subscribe slow path resolves via pubsub', async () => {
    const payload = Buffer.from('result-bytes-slow');
    const waiter = pub.awaitResult('wid-slow', 3000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pub.publishResult('wid-slow', payload);
    const got = await waiter;
    expect(got.equals(payload)).toBe(true);
  });

  it('await_result times out when no result arrives', async () => {
    await expect(pub.awaitResult('wid-never', 200)).rejects.toBeInstanceOf(ResultPublisherTimeoutError);
  });

  it('await_result re-reads the key when the pubsub notification is dropped', async () => {
    const dropping = new DroppingPubSubRedis();
    const dp = new ResultPublisherService(dropping, '');
    const payload = Buffer.from('result-bytes-dropped');
    const waiter = dp.awaitResult('wid-dropped', 3000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await dropping.set(`${RESULT_KEY_SUFFIX}wid-dropped`, payload, 1000);
    const got = await waiter;
    expect(got.equals(payload)).toBe(true);
  });

  it('await_result re-reads the key after the outer-timeout sentinel (reconnect-stall recovery)', async () => {
    const scripted = new ScriptedPubSub([RESULT_PUBSUB_TIMEOUT], 10);
    const redisS = new ScriptedPubSubRedis(scripted);
    const sp = new ResultPublisherService(redisS, '');
    const payload = Buffer.from('result-bytes-sentinel');

    const waiter = sp.awaitResult('wid-sentinel', 3000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await redisS.set(`${RESULT_KEY_SUFFIX}wid-sentinel`, payload, 1000);

    const got = await waiter;
    expect(got.equals(payload)).toBe(true);
    expect(scripted.getMessageCalls).toBe(1);
  });

  it('await_result times out when the sentinel repeats with the key absent', async () => {
    const scripted = new ScriptedPubSub([RESULT_PUBSUB_TIMEOUT, RESULT_PUBSUB_TIMEOUT]);
    const redisS = new ScriptedPubSubRedis(scripted);
    const sp = new ResultPublisherService(redisS, '');

    await expect(sp.awaitResult('wid-sentinel-never', 150)).rejects.toBeInstanceOf(ResultPublisherTimeoutError);
    expect(scripted.getMessageCalls).toBeGreaterThan(0);
  });

  it('await_result keeps waiting when a notification arrives but the key is still absent', async () => {
    const scripted = new ScriptedPubSub([{ data: 'wid-gap' }, RESULT_PUBSUB_TIMEOUT], 10);
    const redisS = new ScriptedPubSubRedis(scripted);
    const sp = new ResultPublisherService(redisS, '');
    const payload = Buffer.from('result-bytes-gap');

    const waiter = sp.awaitResult('wid-gap', 3000);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await redisS.set(`${RESULT_KEY_SUFFIX}wid-gap`, payload, 1000);

    const got = await waiter;
    expect(got.equals(payload)).toBe(true);
    expect(scripted.getMessageCalls).toBe(2);
  });

  it('await_result deadline uses performance.now(), not Date.now()', async () => {
    const scripted = new ScriptedPubSub([]);
    const redisS = new ScriptedPubSubRedis(scripted);
    const sp = new ResultPublisherService(redisS, '');

    const perfSpy = vi.spyOn(performance, 'now');
    const realDateNow = Date.now.bind(Date);
    const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => realDateNow() - 3_600_000);

    try {
      await expect(sp.awaitResult('wid-clock', 150)).rejects.toBeInstanceOf(ResultPublisherTimeoutError);
      expect(perfSpy).toHaveBeenCalled();
      expect(dateSpy).not.toHaveBeenCalled();
    } finally {
      perfSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it('cleanupPubSub logs a warning and does not throw when unsubscribe hangs', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const hangRedis = new HangingCleanupRedis();
      const hp = new ResultPublisherService(hangRedis, '');
      const payload = Buffer.from('result-bytes-hang');
      await hangRedis.set(`${RESULT_KEY_SUFFIX}wid-hang`, payload, 1000);

      const waiter = hp.awaitResult('wid-hang', 1000);
      await vi.advanceTimersByTimeAsync(6_000);
      const got = await waiter;
      expect(got.equals(payload)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('pubsub cleanup timed out for workId=wid-hang'));
    } finally {
      warnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('publish_progress writes progress, message, and a numeric timestamp', async () => {
    await pub.publishProgress('wid-p', 0.42, 'zeroing partition');
    const key = `${PROGRESS_KEY_SUFFIX}wid-p`;
    const hash = redis.hashes.get(key);
    expect(hash).toBeDefined();
    expect(hash?.get('progress')).toBe('0.42');
    expect(hash?.get('message')).toBe('zeroing partition');
    expect(hash?.get('_ts')).toMatch(/^\d+(?:\.\d+)?$/);
    expect(Number.isFinite(Number(hash?.get('_ts')))).toBe(true);
  });

  it('get_progress returns null when no progress exists', async () => {
    await expect(pub.getProgress('wid-missing')).resolves.toBeNull();
  });

  it('get_progress returns the complete progress snapshot', async () => {
    await pub.publishProgress('wid-progress', 0.5, 'halfway');
    const key = `${PROGRESS_KEY_SUFFIX}wid-progress`;
    redis.hashes.get(key)?.set('phase', 'zeroing');

    const snapshot = await pub.getProgress('wid-progress');

    expect(snapshot).toEqual({
      progress: '0.5',
      message: 'halfway',
      _ts: expect.stringMatching(/^\d+(?:\.\d+)?$/),
      phase: 'zeroing',
    });
  });

  it('publish_partial appends to a list', async () => {
    await pub.publishPartial('wid-part', Buffer.from('partial-1'));
    await pub.publishPartial('wid-part', Buffer.from('partial-2'));
    const key = `${PARTIAL_KEY_SUFFIX}wid-part`;
    const list = redis.lists.get(key);
    expect(list?.length).toBe(2);
    expect(Buffer.isBuffer(list?.[0]) && (list?.[0] as Buffer).toString()).toBe('partial-1');
  });

  it('zone prefix is applied to keys and channels', async () => {
    const z = makePub('zone-abc');
    await z.pub.publishResult('wid-p', Buffer.from('terminal'));
    expect(z.redis.strings.has('zone-abc:work:result:wid-p')).toBe(true);
    expect(z.redis.strings.has('work:result:wid-p')).toBe(false);

    await z.pub.publishPartial('wid-p', Buffer.from('p1'));
    expect(z.redis.lists.get('zone-abc:work:partial:wid-p')?.length).toBe(1);
    expect(z.redis.lists.has('work:partial:wid-p')).toBe(false);

    await z.pub.publishProgress('wid-p', 0.5, 'x');
    expect(z.redis.hashes.get('zone-abc:work:progress:wid-p')?.size).toBe(3);
    expect(z.redis.hashes.has('work:progress:wid-p')).toBe(false);
    await expect(z.pub.getProgress('wid-p')).resolves.toMatchObject({ progress: '0.5', message: 'x' });
    await expect(z.pub.getProgress('missing')).resolves.toBeNull();
  });

  it('result key carries a TTL (≤ 24h)', async () => {
    await pub.publishResult('wid-ttl', Buffer.from('terminal'));
    const rec = redis.strings.get(`${RESULT_KEY_SUFFIX}wid-ttl`);
    expect(rec).toBeDefined();
    expect(rec!.exSeconds).toBeGreaterThan(0);
    expect(rec!.exSeconds).toBeLessThanOrEqual(24 * 60 * 60);
  });
});

describe('DispatchStalled', () => {
  it('preserves the timeout hierarchy and progress fields', () => {
    const lastProgress = { progress: '0.42', message: 'zeroing partition', _ts: '1722180000.5' };
    const error = new DispatchStalled('work-123', lastProgress, 612.5);

    expect(error).toBeInstanceOf(DispatchTimeout);
    expect(error.work_id).toBe('work-123');
    expect(error.last_progress).toBe(lastProgress);
    expect(error.stall_seconds).toBe(612.5);
  });
});
