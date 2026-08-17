import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueueRef } from '../../contract';
import { RedisConnectionsService } from '../../datastore/redis-connections.service';

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
vi.mock('bullmq', async (importOriginal) => ({
  ...(await importOriginal<typeof import('bullmq')>()),
  Queue: h.QueueCtor,
}));

import { QueueMutationsService } from '../queue-mutations.service';
import { QueueReaderService } from '../queue-reader.service';

class ScriptedRedis {
  on = vi.fn();
  disconnect = vi.fn();
  scan = vi.fn();
  exists = vi.fn(() => Promise.resolve(1));
  scard = vi.fn();
  keys = vi.fn();
}

class ScriptedQueue {
  getJob = vi.fn();
  getJobCounts = vi.fn();
  drain = vi.fn(() => Promise.resolve());
  clean = vi.fn((): Promise<string[]> => Promise.resolve([]));
  obliterate = vi.fn(() => Promise.resolve());
  close = vi.fn(() => Promise.resolve());
}

const DEVICE = '11111111-2222-3333-4444-555555555555';
const PLAN = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const JOB_ID = `${DEVICE}-provision-${PLAN}`;

const sagaRef: QueueRef = { prefix: 'zone-a', name: 'lifecycle', kind: 'saga' };

function scriptedJob(over: Record<string, unknown> = {}) {
  return {
    id: JOB_ID,
    getState: vi.fn(() => Promise.resolve('failed')),
    retry: vi.fn(() => Promise.resolve()),
    remove: vi.fn(() => Promise.resolve()),
    getDependenciesCount: vi.fn(() => Promise.resolve({ unprocessed: 0 })),
    ...over,
  };
}

function makeRunner() {
  return {
    create: vi.fn((opts: { section: string; opId: string; label: string }) => ({ runId: `run-${opts.opId}` })),
    emit: vi.fn(),
    finalize: vi.fn(),
  };
}

function makeService(ref: QueueRef | null) {
  const reader = new QueueReaderService(
    { listZoneIds: vi.fn(() => Promise.resolve([])) } as never,
    new RedisConnectionsService(),
  );
  const registry = { resolve: vi.fn(() => Promise.resolve(ref)) };
  const runner = makeRunner();
  return { service: new QueueMutationsService(registry as never, reader, runner as never), registry, runner };
}

function emittedLines(runner: ReturnType<typeof makeRunner>): string[] {
  return runner.emit.mock.calls.map((call) => String(call[1]));
}

const before = { wait: 3, active: 1, paused: 2, delayed: 4, prioritized: 1, 'waiting-children': 0, completed: 9, failed: 2 };
const drained = { ...before, wait: 0, paused: 0, delayed: 0, prioritized: 0 };

beforeEach(() => {
  h.holder.redis = new ScriptedRedis();
  h.holder.queue = new ScriptedQueue();
  h.RedisCtor.mockClear();
  h.QueueCtor.mockClear();
});

describe('QueueMutationsService — gates', () => {
  it('404s a queue the registry does not resolve without opening a Queue or minting a run', async () => {
    const { service, runner } = makeService(null);

    await expect(
      service.retryJob('bogus', 'lifecycle', JOB_ID, { state: 'failed', resetAttempts: false }),
    ).resolves.toEqual({ ok: false, status: 404, error: 'unknown queue: bogus:lifecycle' });
    await expect(service.removeJob('bogus', 'lifecycle', JOB_ID)).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'unknown queue: bogus:lifecycle',
    });
    await expect(service.drainQueue('bogus', 'lifecycle', { delayed: false })).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'unknown queue: bogus:lifecycle',
    });
    await expect(
      service.cleanQueue('bogus', 'lifecycle', { state: 'failed', grace: 0, limit: 100 }),
    ).resolves.toEqual({ ok: false, status: 404, error: 'unknown queue: bogus:lifecycle' });

    expect(h.QueueCtor).not.toHaveBeenCalled();
    expect(runner.create).not.toHaveBeenCalled();
  });

  it('404s a reserved or side-key job id without opening the job', async () => {
    const { service, runner } = makeService(sagaRef);

    for (const jobId of ['meta', 'wait', `${JOB_ID}:logs`, `${JOB_ID}:processed`, 'repeat:sweep-x']) {
      await expect(
        service.retryJob('zone-a', 'lifecycle', jobId, { state: 'failed', resetAttempts: false }),
        jobId,
      ).resolves.toEqual({ ok: false, status: 404, error: `unknown job: zone-a:lifecycle:${jobId}` });
      await expect(service.removeJob('zone-a', 'lifecycle', jobId), jobId).resolves.toEqual({
        ok: false,
        status: 404,
        error: `unknown job: zone-a:lifecycle:${jobId}`,
      });
    }

    expect(h.holder.queue.getJob).not.toHaveBeenCalled();
    expect(runner.create).not.toHaveBeenCalled();
  });

  it('404s an absent job without minting a run', async () => {
    h.holder.queue.getJob.mockResolvedValue(null);
    const { service, runner } = makeService(sagaRef);

    await expect(
      service.retryJob('zone-a', 'lifecycle', JOB_ID, { state: 'failed', resetAttempts: false }),
    ).resolves.toEqual({ ok: false, status: 404, error: `unknown job: zone-a:lifecycle:${JOB_ID}` });
    await expect(service.removeJob('zone-a', 'lifecycle', JOB_ID)).resolves.toEqual({
      ok: false,
      status: 404,
      error: `unknown job: zone-a:lifecycle:${JOB_ID}`,
    });

    expect(runner.create).not.toHaveBeenCalled();
  });

  it('404s when the queue vanished between resolve and open', async () => {
    h.holder.redis.exists.mockResolvedValue(0);
    const { service, runner } = makeService(sagaRef);

    await expect(
      service.retryJob('zone-a', 'lifecycle', JOB_ID, { state: 'failed', resetAttempts: false }),
    ).resolves.toEqual({ ok: false, status: 404, error: 'unknown queue: zone-a:lifecycle' });
    await expect(service.drainQueue('zone-a', 'lifecycle', { delayed: false })).resolves.toEqual({
      ok: false,
      status: 404,
      error: 'unknown queue: zone-a:lifecycle',
    });

    expect(h.QueueCtor).not.toHaveBeenCalled();
    expect(runner.create).not.toHaveBeenCalled();
  });
});

describe('QueueMutationsService — retry', () => {
  it('409s when the job is not in the requested state and mints no run', async () => {
    const job = scriptedJob({ getState: vi.fn(() => Promise.resolve('active')) });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    await expect(
      service.retryJob('zone-a', 'lifecycle', JOB_ID, { state: 'failed', resetAttempts: false }),
    ).resolves.toEqual({ ok: false, status: 409, error: `job ${JOB_ID} is active, not failed` });

    expect(job.retry).not.toHaveBeenCalled();
    expect(runner.create).not.toHaveBeenCalled();
  });

  it('mints a queues run, retries from the requested state, and finalizes passed', async () => {
    const job = scriptedJob();
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.retryJob('zone-a', 'lifecycle', JOB_ID, {
      state: 'failed',
      resetAttempts: false,
    });

    expect(outcome).toEqual({ ok: true, runId: 'run-retry-job' });
    expect(runner.create).toHaveBeenCalledWith({
      section: 'queues',
      opId: 'retry-job',
      label: `retry zone-a/lifecycle:${JOB_ID}`,
    });
    expect(job.retry).toHaveBeenCalledWith('failed', { resetAttemptsMade: false });
    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-retry-job' }, 0);
  });

  it('passes a completed retry with attempts reset through to bullmq', async () => {
    const job = scriptedJob({ getState: vi.fn(() => Promise.resolve('completed')) });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service } = makeService(sagaRef);

    const outcome = await service.retryJob('zone-a', 'lifecycle', JOB_ID, {
      state: 'completed',
      resetAttempts: true,
    });

    expect(outcome).toEqual({ ok: true, runId: 'run-retry-job' });
    expect(job.retry).toHaveBeenCalledWith('completed', { resetAttemptsMade: true });
  });

  it('finalizes failed and 409s when bullmq reports the state raced away', async () => {
    const message = `Job ${JOB_ID} is not in the failed state. reprocessJob`;
    const job = scriptedJob({ retry: vi.fn(() => Promise.reject(new Error(message))) });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.retryJob('zone-a', 'lifecycle', JOB_ID, {
      state: 'failed',
      resetAttempts: false,
    });

    expect(outcome).toEqual({ ok: false, status: 409, error: message });
    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-retry-job' }, 1);
  });

  it('409s when the job was removed between the listing read and the retry', async () => {
    const job = scriptedJob({
      retry: vi.fn(() => Promise.reject(new Error(`Missing key for job ${JOB_ID}. reprocessJob`))),
    });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.retryJob('zone-a', 'lifecycle', JOB_ID, {
      state: 'failed',
      resetAttempts: false,
    });

    expect(outcome).toEqual({
      ok: false,
      status: 409,
      error: `job ${JOB_ID} no longer exists — it was removed after the listing read`,
    });
    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-retry-job' }, 1);
  });

  it('finalizes failed and rethrows an infrastructure error', async () => {
    const job = scriptedJob({ retry: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    await expect(
      service.retryJob('zone-a', 'lifecycle', JOB_ID, { state: 'failed', resetAttempts: false }),
    ).rejects.toThrow('ECONNREFUSED');

    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-retry-job' }, 1);
  });
});

describe('QueueMutationsService — remove', () => {
  it('409s an active job without minting a run or calling remove', async () => {
    const job = scriptedJob({ getState: vi.fn(() => Promise.resolve('active')) });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    await expect(service.removeJob('zone-a', 'lifecycle', JOB_ID)).resolves.toEqual({
      ok: false,
      status: 409,
      error: `job ${JOB_ID} is active (locked by a worker)`,
    });

    expect(job.remove).not.toHaveBeenCalled();
    expect(runner.create).not.toHaveBeenCalled();
  });

  it('removes with removeChildren explicitly false so children survive', async () => {
    const job = scriptedJob();
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.removeJob('zone-a', 'lifecycle', JOB_ID);

    expect(outcome).toEqual({ ok: true, runId: 'run-remove-job' });
    expect(runner.create).toHaveBeenCalledWith({
      section: 'queues',
      opId: 'remove-job',
      label: `remove zone-a/lifecycle:${JOB_ID}`,
    });
    expect(job.remove).toHaveBeenCalledTimes(1);
    expect(job.remove).toHaveBeenCalledWith({ removeChildren: false });
    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-remove-job' }, 0);
  });

  it('409s a job with pending children without minting a run or calling remove', async () => {
    const job = scriptedJob({ getDependenciesCount: vi.fn(() => Promise.resolve({ unprocessed: 2 })) });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.removeJob('zone-a', 'lifecycle', JOB_ID);

    expect(outcome).toEqual({
      ok: false,
      status: 409,
      error: `job ${JOB_ID} has 2 pending child(ren); children are kept — remove them first`,
    });
    expect(job.getDependenciesCount).toHaveBeenCalledWith({ unprocessed: true });
    expect(job.remove).not.toHaveBeenCalled();
    expect(runner.create).not.toHaveBeenCalled();
  });

  it('removes a parent whose children have all been processed', async () => {
    const job = scriptedJob({ getDependenciesCount: vi.fn(() => Promise.resolve({ unprocessed: 0 })) });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.removeJob('zone-a', 'lifecycle', JOB_ID);

    expect(outcome).toEqual({ ok: true, runId: 'run-remove-job' });
    expect(job.remove).toHaveBeenCalledWith({ removeChildren: false });
    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-remove-job' }, 0);
  });

  it('maps a raced lock to the same 409 as the active precheck', async () => {
    const job = scriptedJob({
      remove: vi.fn(() =>
        Promise.reject(new Error(`Job ${JOB_ID} could not be removed because it is locked by another worker`)),
      ),
    });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.removeJob('zone-a', 'lifecycle', JOB_ID);

    expect(outcome).toEqual({
      ok: false,
      status: 409,
      error: `job ${JOB_ID} is active (locked by a worker)`,
    });
    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-remove-job' }, 1);
  });

  it('maps a job-scheduler refusal to a 409 that points at the schedule', async () => {
    const job = scriptedJob({
      remove: vi.fn(() =>
        Promise.reject(new Error(`Job ${JOB_ID} belongs to a job scheduler and cannot be removed directly. removeJob`)),
      ),
    });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.removeJob('zone-a', 'lifecycle', JOB_ID);

    expect(outcome).toEqual({
      ok: false,
      status: 409,
      error: `job ${JOB_ID} belongs to a job scheduler — remove the schedule at its source, not the occurrence`,
    });
    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-remove-job' }, 1);
  });

  it('finalizes failed and rethrows an infrastructure error', async () => {
    const job = scriptedJob({ remove: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) });
    h.holder.queue.getJob.mockResolvedValue(job);
    const { service, runner } = makeService(sagaRef);

    await expect(service.removeJob('zone-a', 'lifecycle', JOB_ID)).rejects.toThrow('ECONNREFUSED');

    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-remove-job' }, 1);
  });
});

describe('QueueMutationsService — drain', () => {
  it('forwards the delayed flag and logs the per-state deltas', async () => {
    h.holder.queue.getJobCounts.mockResolvedValueOnce(before).mockResolvedValueOnce(drained);
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.drainQueue('zone-a', 'lifecycle', { delayed: true });

    expect(outcome).toEqual({ ok: true, runId: 'run-drain-queue' });
    expect(h.holder.queue.drain).toHaveBeenCalledWith(true);
    const lines = emittedLines(runner);
    expect(lines.some((line) => line.includes('wait: 3 -> 0'))).toBe(true);
    expect(lines.some((line) => line.includes('paused: 2 -> 0'))).toBe(true);
    expect(lines.some((line) => line.includes('delayed: 4 -> 0'))).toBe(true);
    expect(lines.some((line) => line.includes('prioritized: 1 -> 0'))).toBe(true);
    expect(lines.some((line) => line.includes('active, completed, failed, waiting-children untouched'))).toBe(true);
    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-drain-queue' }, 0);
  });

  it('leaves the delayed set alone unless asked', async () => {
    const kept = { ...before, wait: 0, paused: 0, prioritized: 0 };
    h.holder.queue.getJobCounts.mockResolvedValueOnce(before).mockResolvedValueOnce(kept);
    const { service, runner } = makeService(sagaRef);

    await service.drainQueue('zone-a', 'lifecycle', { delayed: false });

    expect(h.holder.queue.drain).toHaveBeenCalledWith(false);
    const lines = emittedLines(runner);
    expect(lines.some((line) => line.includes('wait: 3 -> 0'))).toBe(true);
    expect(lines.some((line) => line.includes('[drain] delayed:'))).toBe(false);
  });

  it('finalizes failed and rethrows when the drain call fails', async () => {
    h.holder.queue.getJobCounts.mockResolvedValue(before);
    h.holder.queue.drain.mockRejectedValue(new Error('ECONNREFUSED'));
    const { service, runner } = makeService(sagaRef);

    await expect(service.drainQueue('zone-a', 'lifecycle', { delayed: false })).rejects.toThrow('ECONNREFUSED');

    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-drain-queue' }, 1);
  });

  it('finalizes the run when the post-drain count read fails after the drain landed', async () => {
    h.holder.queue.getJobCounts.mockResolvedValueOnce(before).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.drainQueue('zone-a', 'lifecycle', { delayed: false });

    expect(outcome).toEqual({ ok: true, runId: 'run-drain-queue' });
    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-drain-queue' }, 0);
    expect(emittedLines(runner).some((line) => line.includes('post-drain counts unavailable: ECONNREFUSED'))).toBe(
      true,
    );
  });
});

describe('QueueMutationsService — clean', () => {
  it('forwards grace, limit, and state, and logs the removed count', async () => {
    h.holder.queue.clean.mockResolvedValue(['j1', 'j2']);
    const { service, runner } = makeService(sagaRef);

    const outcome = await service.cleanQueue('zone-a', 'lifecycle', { state: 'failed', grace: 5_000, limit: 100 });

    expect(outcome).toEqual({ ok: true, runId: 'run-clean-queue' });
    expect(runner.create).toHaveBeenCalledWith({
      section: 'queues',
      opId: 'clean-queue',
      label: 'clean zone-a/lifecycle failed',
    });
    expect(h.holder.queue.clean).toHaveBeenCalledWith(5_000, 100, 'failed');
    expect(emittedLines(runner).some((line) => line.includes('removed 2 failed job(s) (grace 5000ms, limit 100)'))).toBe(
      true,
    );
    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-clean-queue' }, 0);
  });

  it('finalizes failed and rethrows when the clean call fails', async () => {
    h.holder.queue.clean.mockRejectedValue(new Error('ECONNREFUSED'));
    const { service, runner } = makeService(sagaRef);

    await expect(
      service.cleanQueue('zone-a', 'lifecycle', { state: 'completed', grace: 0, limit: 1_000 }),
    ).rejects.toThrow('ECONNREFUSED');

    expect(runner.finalize).toHaveBeenCalledWith({ runId: 'run-clean-queue' }, 1);
  });
});

describe('QueueMutationsService — no bulk wipe', () => {
  it('never calls queue.obliterate on any code path', async () => {
    h.holder.queue.getJob.mockResolvedValue(scriptedJob());
    h.holder.queue.getJobCounts.mockResolvedValue(before);
    const { service } = makeService(sagaRef);

    await service.retryJob('zone-a', 'lifecycle', JOB_ID, { state: 'failed', resetAttempts: false });
    await service.removeJob('zone-a', 'lifecycle', JOB_ID);
    await service.drainQueue('zone-a', 'lifecycle', { delayed: true });
    await service.cleanQueue('zone-a', 'lifecycle', { state: 'failed', grace: 0, limit: 1_000 });

    expect(h.holder.queue.obliterate).not.toHaveBeenCalled();
  });
});
