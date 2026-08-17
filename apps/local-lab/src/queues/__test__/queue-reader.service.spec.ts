import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueueRef } from '../../contract';

const h = vi.hoisted(() => {
  const holder = {
    redis: null as unknown as ScriptedRedis,
    queue: null as unknown as ScriptedQueue,
  };
  const RedisCtor = vi.fn(function () {
    return holder.redis;
  });
  const QueueCtor = vi.fn(function () {
    return holder.queue;
  });
  return { holder, RedisCtor, QueueCtor };
});

vi.mock('ioredis', () => ({ default: h.RedisCtor }));
vi.mock('bullmq', () => ({ Queue: h.QueueCtor }));

import { RedisConnectionsService } from '../../datastore/redis-connections.service';
import { QueueReaderService } from '../queue-reader.service';

class ScriptedPipeline {
  llen = vi.fn(() => this);
  zcard = vi.fn(() => this);
  exec = vi.fn();
}

class ScriptedRedis {
  pipeline = new ScriptedPipeline();
  on = vi.fn();
  disconnect = vi.fn();
  multi = vi.fn(() => this.pipeline);
  scan = vi.fn();
  exists = vi.fn();
  scard = vi.fn();
  keys = vi.fn();
}

class ScriptedQueue {
  getJobCounts = vi.fn();
  isPaused = vi.fn();
  getWorkers = vi.fn();
  close = vi.fn(() => Promise.resolve());
}

const ALL_STATES = [
  'wait',
  'active',
  'paused',
  'delayed',
  'completed',
  'failed',
  'waiting-children',
  'prioritized',
] as const;

const ZERO_COUNTS = {
  wait: 0,
  active: 0,
  paused: 0,
  delayed: 0,
  prioritized: 0,
  'waiting-children': 0,
  completed: 0,
  failed: 0,
};

const sagaRef: QueueRef = { prefix: 'zone-a', name: 'lifecycle', kind: 'saga' };

let connections: RedisConnectionsService;

function makeReader(zoneIds: string[] = []) {
  return new QueueReaderService({ listZoneIds: vi.fn(() => Promise.resolve(zoneIds)) } as never, connections);
}

beforeEach(() => {
  connections = new RedisConnectionsService();
  h.holder.redis = new ScriptedRedis();
  h.holder.queue = new ScriptedQueue();
  h.RedisCtor.mockClear();
  h.QueueCtor.mockClear();
});

describe('QueueReaderService phantom-queue gate', () => {
  it('constructs no Queue at all for a ref whose meta key is absent', async () => {
    h.holder.redis.exists.mockResolvedValue(0);
    const summary = await makeReader().summary(sagaRef);

    expect(h.QueueCtor).not.toHaveBeenCalled();
    expect(h.holder.redis.exists).toHaveBeenCalledWith('zone-a:lifecycle:meta');
    expect(summary).toEqual({
      ...sagaRef,
      counts: ZERO_COUNTS,
      stalled: 0,
      paused: false,
      workers: 0,
      inFlight: 0,
      readError: null,
    });
  });

  it('reads nothing else once the gate says the queue is absent', async () => {
    h.holder.redis.exists.mockResolvedValue(0);
    await makeReader().summary(sagaRef);

    expect(h.holder.redis.scard).not.toHaveBeenCalled();
    expect(h.holder.queue.getJobCounts).not.toHaveBeenCalled();
  });

  it('returns zeroed counts without a Queue when counts() is asked for an absent queue', async () => {
    h.holder.redis.exists.mockResolvedValue(0);
    await expect(makeReader().counts(sagaRef)).resolves.toEqual(ZERO_COUNTS);
    expect(h.QueueCtor).not.toHaveBeenCalled();
  });

  it('builds the Queue against the ref prefix with the meta upsert suppressed', async () => {
    h.holder.redis.exists.mockResolvedValue(1);
    h.holder.queue.getJobCounts.mockResolvedValue({});
    await makeReader().counts(sagaRef);

    expect(h.QueueCtor).toHaveBeenCalledTimes(1);
    expect(h.QueueCtor).toHaveBeenCalledWith('lifecycle', {
      connection: { url: expect.stringContaining('redis://'), maxRetriesPerRequest: 2, connectTimeout: 5_000 },
      prefix: 'zone-a',
      skipMetasUpdate: true,
    });
  });

  it('builds one Queue when two reads of the same ref race, leaking no connection', async () => {
    h.holder.redis.exists.mockResolvedValue(1);
    h.holder.queue.getJobCounts.mockResolvedValue({});
    const reader = makeReader();
    await Promise.all([reader.counts(sagaRef), reader.counts(sagaRef), reader.summary(sagaRef)]);

    expect(h.QueueCtor).toHaveBeenCalledTimes(1);
  });

  it('re-gates a ref whose queue was absent, so one created later is still picked up', async () => {
    h.holder.redis.exists.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    h.holder.queue.getJobCounts.mockResolvedValue({});
    const reader = makeReader();
    await reader.counts(sagaRef);
    await reader.counts(sagaRef);

    expect(h.holder.redis.exists).toHaveBeenCalledTimes(2);
    expect(h.QueueCtor).toHaveBeenCalledTimes(1);
  });

  it('caches the Queue per prefix:name so a second read gates and constructs once', async () => {
    h.holder.redis.exists.mockResolvedValue(1);
    h.holder.queue.getJobCounts.mockResolvedValue({});
    const reader = makeReader();
    await reader.counts(sagaRef);
    await reader.counts(sagaRef);

    expect(h.QueueCtor).toHaveBeenCalledTimes(1);
    expect(h.holder.redis.exists).toHaveBeenCalledTimes(1);
  });
});

describe('QueueReaderService.summary', () => {
  beforeEach(() => {
    h.holder.redis.exists.mockResolvedValue(1);
    h.holder.redis.scard.mockResolvedValue(3);
    h.holder.queue.isPaused.mockResolvedValue(true);
    h.holder.queue.getWorkers.mockResolvedValue([{ name: 'w1' }, { name: 'w2' }]);
    h.holder.queue.getJobCounts.mockResolvedValue({
      wait: 2,
      active: 1,
      paused: 4,
      delayed: 5,
      prioritized: 6,
      'waiting-children': 7,
      completed: 8,
      failed: 9,
    });
  });

  it('shapes the full summary and totals only the not-yet-finished states', async () => {
    await expect(makeReader().summary(sagaRef)).resolves.toEqual({
      ...sagaRef,
      counts: {
        wait: 2,
        active: 1,
        paused: 4,
        delayed: 5,
        prioritized: 6,
        'waiting-children': 7,
        completed: 8,
        failed: 9,
      },
      stalled: 3,
      paused: true,
      workers: 2,
      inFlight: 18,
      readError: null,
    });
  });

  it('takes stalled from SCARD because the bullmq job counts do not cover that set', async () => {
    const summary = await makeReader().summary(sagaRef);

    expect(h.holder.redis.scard).toHaveBeenCalledWith('zone-a:lifecycle:stalled');
    expect(h.holder.queue.getJobCounts).toHaveBeenCalledWith(...ALL_STATES);
    expect(h.holder.queue.getJobCounts).not.toHaveBeenCalledWith(expect.stringContaining('stalled'));
    expect(summary.stalled).toBe(3);
  });

  it('defaults a state the counts reply omits to zero rather than NaN', async () => {
    h.holder.queue.getJobCounts.mockResolvedValue({ wait: 2, active: 'nonsense' });
    const summary = await makeReader().summary(sagaRef);

    expect(summary.counts).toEqual({ ...ZERO_COUNTS, wait: 2 });
    expect(summary.inFlight).toBe(2);
  });

  it('marks the row unreadable rather than empty when redis is down', async () => {
    h.holder.redis.exists.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(makeReader().summary(sagaRef)).resolves.toEqual({
      ...sagaRef,
      counts: ZERO_COUNTS,
      stalled: 0,
      paused: null,
      workers: null,
      inFlight: 0,
      readError: 'ECONNREFUSED',
    });
  });

  it('keeps the counts it read when only the worker probe fails', async () => {
    h.holder.queue.getWorkers.mockRejectedValue(new Error('CLIENT LIST refused'));
    const summary = await makeReader().summary(sagaRef);

    expect(summary.readError).toBeNull();
    expect(summary.counts.wait).toBe(2);
    expect(summary.inFlight).toBe(18);
    expect(summary.stalled).toBe(3);
    expect(summary.paused).toBe(true);
    expect(summary.workers).toBeNull();
  });

  it('keeps the counts it read when only the pause probe fails', async () => {
    h.holder.queue.isPaused.mockRejectedValue(new Error('WRONGTYPE'));
    const summary = await makeReader().summary(sagaRef);

    expect(summary.readError).toBeNull();
    expect(summary.counts.wait).toBe(2);
    expect(summary.paused).toBeNull();
    expect(summary.workers).toBe(2);
  });

  it('marks the row unreadable when the stalled-set read fails', async () => {
    h.holder.redis.scard.mockRejectedValue(new Error('WRONGTYPE'));
    const summary = await makeReader().summary(sagaRef);

    expect(summary.readError).toBe('WRONGTYPE');
    expect(summary.counts).toEqual(ZERO_COUNTS);
  });

  it('separates a readable queue with an unknown worker count from an unreadable one', async () => {
    h.holder.queue.getWorkers.mockRejectedValue(new Error('CLIENT LIST refused'));
    const readable = await makeReader().summary(sagaRef);

    h.holder.queue.getJobCounts.mockRejectedValue(new Error('ECONNREFUSED'));
    const unreadable = await makeReader().summary(sagaRef);

    expect(readable.workers).toBeNull();
    expect(unreadable.workers).toBeNull();
    expect(readable.readError).toBeNull();
    expect(unreadable.readError).toBe('ECONNREFUSED');
    expect(readable.counts).not.toEqual(unreadable.counts);
  });

  it('marks the row unreadable when a read fails after the gate passed', async () => {
    h.holder.queue.getJobCounts.mockRejectedValue(new Error('WRONGTYPE'));
    const summary = await makeReader().summary(sagaRef);

    expect(summary.readError).toBe('WRONGTYPE');
    expect(summary.counts).toEqual(ZERO_COUNTS);
    expect(summary.stalled).toBe(0);
  });

  it('distinguishes a genuinely empty queue from one it could not read', async () => {
    h.holder.redis.exists.mockResolvedValue(0);
    const absent = await makeReader().summary(sagaRef);

    h.holder.redis.exists.mockRejectedValue(new Error('ECONNREFUSED'));
    const unreadable = await makeReader().summary(sagaRef);

    expect(absent.readError).toBeNull();
    expect(unreadable.readError).toBe('ECONNREFUSED');
    expect(absent.counts).toEqual(unreadable.counts);
  });
});

describe('QueueReaderService.scanMetaKeys', () => {
  it('uses SCAN with MATCH and COUNT and loops the cursor until it returns "0"', async () => {
    h.holder.redis.scan
      .mockResolvedValueOnce(['7', ['zone-a:lifecycle:meta']])
      .mockResolvedValueOnce(['0', ['zone-b:lifecycle:meta']]);
    const keys = await makeReader().scanMetaKeys('*:lifecycle:meta');

    expect(keys).toEqual(['zone-a:lifecycle:meta', 'zone-b:lifecycle:meta']);
    expect(h.holder.redis.scan).toHaveBeenNthCalledWith(1, '0', 'MATCH', '*:lifecycle:meta', 'COUNT', 200);
    expect(h.holder.redis.scan).toHaveBeenNthCalledWith(2, '7', 'MATCH', '*:lifecycle:meta', 'COUNT', 200);
  });

  it('never falls back to the blocking KEYS command', async () => {
    h.holder.redis.scan.mockResolvedValue(['0', []]);
    await makeReader().scanMetaKeys('bull:*:meta');

    expect(h.holder.redis.keys).not.toHaveBeenCalled();
  });
});

describe('QueueReaderService.scanKeys', () => {
  it('stops at the cap mid-cursor and reports the listing as truncated', async () => {
    h.holder.redis.scan.mockResolvedValueOnce(['7', ['a', 'b', 'c']]).mockResolvedValueOnce(['0', ['d']]);
    await expect(makeReader().scanKeys('zone-a:lifecycle:dev-*', 2)).resolves.toEqual({
      keys: ['a', 'b'],
      truncated: true,
    });

    expect(h.holder.redis.scan).toHaveBeenCalledTimes(1);
  });

  it('reports untruncated when the cursor completes under the cap', async () => {
    h.holder.redis.scan.mockResolvedValueOnce(['7', ['a']]).mockResolvedValueOnce(['0', ['b']]);
    await expect(makeReader().scanKeys('zone-a:lifecycle:dev-*', 50)).resolves.toEqual({
      keys: ['a', 'b'],
      truncated: false,
    });
  });

  it('never falls back to the blocking KEYS command', async () => {
    h.holder.redis.scan.mockResolvedValue(['0', []]);
    await makeReader().scanKeys('zone-a:lifecycle:dev-*', 10);

    expect(h.holder.redis.keys).not.toHaveBeenCalled();
  });
});

describe('QueueReaderService.withQueue', () => {
  it('hands the gated queue to the callback and returns its result', async () => {
    h.holder.redis.exists.mockResolvedValue(1);
    const seen: unknown[] = [];
    const result = await makeReader().withQueue(sagaRef, async (queue) => {
      seen.push(queue);
      return 'read';
    });

    expect(result).toBe('read');
    expect(seen).toEqual([h.holder.queue]);
  });

  it('returns null and never runs the callback or builds a Queue for an absent ref', async () => {
    h.holder.redis.exists.mockResolvedValue(0);
    const fn = vi.fn(() => Promise.resolve('read'));

    await expect(makeReader().withQueue(sagaRef, fn)).resolves.toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(h.QueueCtor).not.toHaveBeenCalled();
  });

  it('shares the cached queue with the counting readers instead of opening a second one', async () => {
    h.holder.redis.exists.mockResolvedValue(1);
    h.holder.queue.getJobCounts.mockResolvedValue({});
    const reader = makeReader();
    await reader.counts(sagaRef);
    await reader.withQueue(sagaRef, async () => 'read');

    expect(h.QueueCtor).toHaveBeenCalledTimes(1);
  });

  it('propagates a callback failure rather than swallowing it into null', async () => {
    h.holder.redis.exists.mockResolvedValue(1);
    await expect(makeReader().withQueue(sagaRef, () => Promise.reject(new Error('WRONGTYPE')))).rejects.toThrow(
      'WRONGTYPE',
    );
  });
});

describe('QueueReaderService.inFlightCount — the fleet-mode-flip guard', () => {
  it('fans LLEN/ZCARD across every zone and both saga queues', async () => {
    const reader = makeReader(['zone-a', 'zone-b']);
    h.holder.redis.pipeline.exec.mockResolvedValue(Array(2 * 2 * (3 + 2)).fill([null, 0]));

    await expect(reader.inFlightCount()).resolves.toBe(0);
    expect(h.holder.redis.pipeline.llen).toHaveBeenCalledTimes(2 * 2 * 3);
    expect(h.holder.redis.pipeline.zcard).toHaveBeenCalledTimes(2 * 2 * 2);
  });

  it('sums in-flight jobs across zones and queues (a positive total blocks the flip)', async () => {
    const reader = makeReader(['zone-a']);
    const replies: [null, number][] = Array(10).fill([null, 0]);
    replies[0] = [null, 2];
    replies[5] = [null, 3];
    h.holder.redis.pipeline.exec.mockResolvedValue(replies);

    await expect(reader.inFlightCount()).resolves.toBe(5);
  });

  it('ignores per-key errors and non-numeric replies (never NaN)', async () => {
    const reader = makeReader(['zone-a']);
    const replies: [Error | null, unknown][] = Array(10).fill([null, 0]);
    replies[0] = [new Error('WRONGTYPE'), null];
    replies[1] = [null, 'not-a-number'];
    replies[2] = [null, 4];
    h.holder.redis.pipeline.exec.mockResolvedValue(replies);

    await expect(reader.inFlightCount()).resolves.toBe(4);
  });

  it('reads blindly, gating on no meta key and building no Queue', async () => {
    const reader = makeReader(['zone-a']);
    h.holder.redis.pipeline.exec.mockResolvedValue(Array(10).fill([null, 1]));

    await expect(reader.inFlightCount()).resolves.toBe(10);
    expect(h.holder.redis.exists).not.toHaveBeenCalled();
    expect(h.QueueCtor).not.toHaveBeenCalled();
  });

  it('returns 0 without touching Redis when there are no configured zones', async () => {
    await expect(makeReader([]).inFlightCount()).resolves.toBe(0);
    expect(h.RedisCtor).not.toHaveBeenCalled();
  });

  it('counts the bridge redis, ignoring a datastore override the inspector would follow', async () => {
    vi.stubEnv('DATASTORE_REDIS_URL', 'redis://datastore-view:6399');
    vi.stubEnv('BRIDGE_REDIS_URL', 'redis://bridge-redis:6379');
    const reader = makeReader(['zone-a']);
    h.holder.redis.pipeline.exec.mockResolvedValue(Array(10).fill([null, 0]));
    await reader.inFlightCount();

    expect(h.RedisCtor).toHaveBeenCalledWith('redis://bridge-redis:6379', expect.anything());
    vi.unstubAllEnvs();
  });

  it('always disconnects its client', async () => {
    const reader = makeReader(['zone-a']);
    h.holder.redis.pipeline.exec.mockResolvedValue(Array(10).fill([null, 0]));
    await reader.inFlightCount();

    expect(h.holder.redis.disconnect).toHaveBeenCalled();
  });

  it('disconnects its client even when the pipeline throws', async () => {
    const reader = makeReader(['zone-a']);
    h.holder.redis.pipeline.exec.mockRejectedValue(new Error('ECONNRESET'));

    await expect(reader.inFlightCount()).rejects.toThrow('ECONNRESET');
    expect(h.holder.redis.disconnect).toHaveBeenCalled();
  });
});

describe('QueueReaderService.onModuleDestroy', () => {
  it('closes every cached queue', async () => {
    h.holder.redis.exists.mockResolvedValue(1);
    h.holder.queue.getJobCounts.mockResolvedValue({});
    const reader = makeReader();
    await reader.counts(sagaRef);
    await reader.onModuleDestroy();

    expect(h.holder.queue.close).toHaveBeenCalledTimes(1);
  });

  it('leaves the shared client to its owner rather than disconnecting it', async () => {
    h.holder.redis.exists.mockResolvedValue(1);
    h.holder.queue.getJobCounts.mockResolvedValue({});
    const reader = makeReader();
    await reader.counts(sagaRef);
    await reader.onModuleDestroy();

    expect(h.holder.redis.disconnect).not.toHaveBeenCalled();

    connections.onModuleDestroy();
    expect(h.holder.redis.disconnect).toHaveBeenCalledTimes(1);
  });
});
