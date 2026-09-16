import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  JOB_LOG_MAX_STREAM_ENTRIES,
  JOB_LOG_TTL_SECONDS,
  JobLogStreamSink,
  type JobLogRedis,
} from '../job-log-stream-sink';

interface FakeRedis extends JobLogRedis {
  xadd: ReturnType<
    typeof vi.fn<(key: string, fields: Record<string, string>, maxlen?: number, jobId?: string) => Promise<unknown>>
  >;
  expire: ReturnType<typeof vi.fn<(key: string, seconds: number, jobId?: string) => Promise<boolean>>>;
}

function createFakeRedis(): FakeRedis {
  return {
    xadd: vi.fn<(key: string, fields: Record<string, string>, maxlen?: number, jobId?: string) => Promise<unknown>>(
      async () => '1-1',
    ),
    expire: vi.fn<(key: string, seconds: number, jobId?: string) => Promise<boolean>>(async () => true),
  };
}

describe('JobLogStreamSink', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('buffers below thresholds and flushes everything on the timer with one expire per key', async () => {
    vi.useFakeTimers();
    const redis = createFakeRedis();
    const sink = new JobLogStreamSink(redis);
    sink.start();

    sink.enqueue('j1', { message: 'a' });
    sink.enqueue('j1', { message: 'b' });
    sink.enqueue('j2', { message: 'c' });
    expect(redis.xadd).not.toHaveBeenCalled();
    expect(redis.expire).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    expect(redis.xadd).toHaveBeenCalledTimes(3);
    expect(redis.xadd).toHaveBeenNthCalledWith(1, 'job:logs:j1', { message: 'a' }, JOB_LOG_MAX_STREAM_ENTRIES);
    expect(redis.xadd).toHaveBeenNthCalledWith(2, 'job:logs:j1', { message: 'b' }, JOB_LOG_MAX_STREAM_ENTRIES);
    expect(redis.xadd).toHaveBeenNthCalledWith(3, 'job:logs:j2', { message: 'c' }, JOB_LOG_MAX_STREAM_ENTRIES);
    expect(redis.expire).toHaveBeenCalledTimes(2);
    expect(redis.expire).toHaveBeenCalledWith('job:logs:j1', 2_592_000);
    expect(redis.expire).toHaveBeenCalledWith('job:logs:j2', JOB_LOG_TTL_SECONDS);

    await sink.stop();
  });

  it('flushes immediately when the 50th entry is enqueued', async () => {
    const redis = createFakeRedis();
    const sink = new JobLogStreamSink(redis);

    for (let i = 0; i < 49; i += 1) {
      sink.enqueue('j1', { message: `m${i}` });
    }
    expect(redis.xadd).not.toHaveBeenCalled();

    sink.enqueue('j1', { message: 'm49' });

    await vi.waitFor(() => {
      expect(redis.expire).toHaveBeenCalledTimes(1);
    });
    expect(redis.xadd).toHaveBeenCalledTimes(50);
    expect(redis.expire).toHaveBeenCalledWith('job:logs:j1', JOB_LOG_TTL_SECONDS);
  });

  it('refreshes the ttl on every flush', async () => {
    vi.useFakeTimers();
    const redis = createFakeRedis();
    const sink = new JobLogStreamSink(redis);
    sink.start();

    sink.enqueue('j1', { message: 'a' });
    await vi.advanceTimersByTimeAsync(5000);
    sink.enqueue('j1', { message: 'b' });
    await vi.advanceTimersByTimeAsync(5000);

    expect(redis.expire).toHaveBeenCalledTimes(2);
    expect(redis.expire).toHaveBeenNthCalledWith(1, 'job:logs:j1', JOB_LOG_TTL_SECONDS);
    expect(redis.expire).toHaveBeenNthCalledWith(2, 'job:logs:j1', JOB_LOG_TTL_SECONDS);

    await sink.stop();
  });

  it('drops the batch when xadd fails and does not throw', async () => {
    const redis = createFakeRedis();
    redis.xadd.mockRejectedValueOnce(new Error('redis down'));
    const sink = new JobLogStreamSink(redis);

    sink.enqueue('j1', { message: 'a' });
    sink.enqueue('j1', { message: 'b' });
    await expect(sink.flush()).resolves.toBeUndefined();

    expect(redis.xadd).toHaveBeenCalledTimes(1);
    expect(redis.expire).not.toHaveBeenCalled();

    await sink.flush();
    expect(redis.xadd).toHaveBeenCalledTimes(1);
  });

  it('stop flushes buffered entries', async () => {
    const redis = createFakeRedis();
    const sink = new JobLogStreamSink(redis);
    sink.start();

    sink.enqueue('j1', { message: 'a' });
    await sink.stop();

    expect(redis.xadd).toHaveBeenCalledWith('job:logs:j1', { message: 'a' }, JOB_LOG_MAX_STREAM_ENTRIES);
    expect(redis.expire).toHaveBeenCalledWith('job:logs:j1', JOB_LOG_TTL_SECONDS);
  });

  it('stop flushes entries enqueued while a flush is in flight', async () => {
    const redis = createFakeRedis();
    let release: ((value: unknown) => void) | undefined;
    redis.xadd.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const sink = new JobLogStreamSink(redis);

    for (let i = 0; i < 50; i += 1) {
      sink.enqueue('j1', { message: `m${i}` });
    }
    sink.enqueue('j2', { message: 'late' });

    const stopped = sink.stop();
    expect(redis.xadd).not.toHaveBeenCalledWith('job:logs:j2', { message: 'late' }, JOB_LOG_MAX_STREAM_ENTRIES);

    release?.('1-1');
    await stopped;

    expect(redis.xadd).toHaveBeenCalledWith('job:logs:j2', { message: 'late' }, JOB_LOG_MAX_STREAM_ENTRIES);
    expect(redis.expire).toHaveBeenCalledWith('job:logs:j2', JOB_LOG_TTL_SECONDS);
  });

  it('drops the oldest buffered entry per enqueue once the 10k cap is hit', async () => {
    const redis = createFakeRedis();
    let release: ((value: unknown) => void) | undefined;
    redis.xadd.mockImplementationOnce(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const sink = new JobLogStreamSink(redis);

    for (let i = 0; i < 50; i += 1) {
      sink.enqueue('warm', { message: `w${i}` });
    }
    sink.enqueue('old', { message: 'dropped' });
    for (let i = 0; i < 10_000; i += 1) {
      sink.enqueue('new', { message: `m${i}` });
    }

    release?.('1-1');
    await sink.stop();

    const keys = redis.xadd.mock.calls.map(([key]) => key);
    expect(keys).not.toContain('job:logs:old');
    const newEntries = redis.xadd.mock.calls.filter(([key]) => key === 'job:logs:new');
    expect(newEntries).toHaveLength(9_999);
    expect(newEntries[0]?.[1]).toEqual({ message: 'm1' });
    expect(newEntries.at(-1)?.[1]).toEqual({ message: 'm9999' });
  });
});
