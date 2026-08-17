import type { Job, Queue } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContextLogger } from '../../logger/logger.service.js';
import { BullmqSupervisorService, type SupervisedWorker, type WorkerFactory } from '../bullmq-supervisor.service.js';

const RESTART_DELAY_MS = 5_000;
const CLOSE_TIMEOUT_MS = 10_000;
const SWEEP_INTERVAL_MS = 3_000;

interface LoggerSpy {
  logger: ContextLogger;
  info: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function makeLoggerSpy(): LoggerSpy {
  const info = vi.fn(async () => {});
  const error = vi.fn(async () => {});
  const debug = vi.fn(async () => {});
  const logger = {
    info,
    error,
    warning: vi.fn(async () => {}),
    debug,
  } as unknown as ContextLogger;
  return { logger, info, error, debug };
}

interface SweepQueueSpy {
  queue: Queue;
  zrangebyscore: ReturnType<typeof vi.fn>;
  zscore: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeSweepQueue(
  jobs: Job[] = [],
  name = 'test',
  dueJobIds = jobs.map((job) => job.id),
  scores: Record<string, number | null> = {},
): SweepQueueSpy {
  const zrangebyscore = vi.fn(async () => dueJobIds);
  const zscore = vi.fn(async (_key: string, id: string) =>
    Object.hasOwn(scores, id) ? (scores[id]?.toString() ?? null) : '0',
  );
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  const close = vi.fn(async () => {});
  const queue = {
    name,
    client: Promise.resolve({ zrangebyscore, zscore }),
    toKey: (type: string) => `${name}:${type}`,
    getJob: async (id: string) => jobsById.get(id),
    close,
  } as unknown as Queue;
  return { queue, zrangebyscore, zscore, close };
}

function makeDelayedJob(promote: () => Promise<void>, id = 'job-1'): Job {
  return { id, promote } as unknown as Job;
}

function makeIdleWorker(): SupervisedWorker {
  let resolveRun: (() => void) | null = null;
  const runPromise = new Promise<void>((resolve) => {
    resolveRun = resolve;
  });
  return {
    async run() {
      await runPromise;
    },
    async close() {
      if (resolveRun !== null) {
        resolveRun();
        resolveRun = null;
      }
    },
  };
}

describe('BullmqSupervisorService', () => {
  it('init: not shutting down by default', () => {
    const sup = new BullmqSupervisorService();
    expect(sup.isShuttingDown()).toBe(false);
  });

  it('requestShutdown flips isShuttingDown to true', () => {
    const sup = new BullmqSupervisorService();
    sup.requestShutdown();
    expect(sup.isShuttingDown()).toBe(true);
  });

  it('requestShutdown is idempotent', () => {
    const sup = new BullmqSupervisorService();
    sup.requestShutdown();
    sup.requestShutdown();
    expect(sup.isShuttingDown()).toBe(true);
  });

  it('waitForShutdown resolves after requestShutdown when no workers are started', async () => {
    const sup = new BullmqSupervisorService();
    const waiter = sup.waitForShutdown();
    sup.requestShutdown();
    await waiter;
    expect(sup.isShuttingDown()).toBe(true);
  });

  it('force-closes active workers on requestShutdown', async () => {
    const sup = new BullmqSupervisorService();
    const lifecycleClose = vi.fn(async () => {});
    const collectionClose = vi.fn(async () => {});
    const lifecycle: SupervisedWorker = {
      async run() {
        await new Promise(() => {});
      },
      close: lifecycleClose,
    };
    const collection: SupervisedWorker = {
      async run() {
        await new Promise(() => {});
      },
      close: collectionClose,
    };
    const lifecycleFactory: WorkerFactory = () => lifecycle;
    const collectionFactory: WorkerFactory = () => collection;

    sup.start(
      lifecycleFactory,
      collectionFactory,
      makeSweepQueue().queue,
      makeSweepQueue().queue,
      SWEEP_INTERVAL_MS / 1000,
    );
    await new Promise((resolve) => setImmediate(resolve));
    sup.requestShutdown();
    await new Promise((resolve) => setImmediate(resolve));

    expect(lifecycleClose).toHaveBeenCalledWith(true);
    expect(collectionClose).toHaveBeenCalledWith(true);
  });

  it('start is a no-op when called twice', async () => {
    const sup = new BullmqSupervisorService();
    let created = 0;
    const factory: WorkerFactory = () => {
      created += 1;
      return makeIdleWorker();
    };
    const lifecycleQueue = makeSweepQueue().queue;
    const collectionQueue = makeSweepQueue().queue;
    sup.start(factory, factory, lifecycleQueue, collectionQueue, SWEEP_INTERVAL_MS / 1000);
    sup.start(factory, factory, lifecycleQueue, collectionQueue, SWEEP_INTERVAL_MS / 1000);
    expect(created).toBe(2);
    sup.requestShutdown();
    await sup.waitForShutdown();
  });

  it('onModuleDestroy triggers shutdown and joins tasks', async () => {
    const sup = new BullmqSupervisorService();
    const factory: WorkerFactory = () => makeIdleWorker();
    sup.start(factory, factory, makeSweepQueue().queue, makeSweepQueue().queue, SWEEP_INTERVAL_MS / 1000);
    await sup.onModuleDestroy();
    expect(sup.isShuttingDown()).toBe(true);
  });

  describe('delayed-job sweep', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('promotes due jobs and skips future jobs', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-07-31T23:00:00.000Z'));
      const duePromote = vi.fn(async () => {});
      const futurePromote = vi.fn(async () => {});
      const lifecycleQueue = makeSweepQueue(
        [makeDelayedJob(duePromote, 'due'), makeDelayedJob(futurePromote, 'future')],
        'lifecycle',
        ['due', 'future'],
        { future: (Date.now() + 90_000) * 0x1000 },
      );
      const collectionQueue = makeSweepQueue();
      const sup = new BullmqSupervisorService(makeLoggerSpy().logger);

      sup.start(
        makeIdleWorker,
        makeIdleWorker,
        lifecycleQueue.queue,
        collectionQueue.queue,
        SWEEP_INTERVAL_MS / 1000,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(duePromote).toHaveBeenCalledOnce();
      expect(futurePromote).not.toHaveBeenCalled();
      expect(lifecycleQueue.zrangebyscore).toHaveBeenCalledWith(
        'lifecycle:delayed',
        0,
        Date.now() * 0x1000 + 0xfff,
        'LIMIT',
        0,
        20,
      );
      expect(lifecycleQueue.zscore).toHaveBeenCalledWith('lifecycle:delayed', 'future');

      sup.requestShutdown();
      await sup.waitForShutdown();
    });

    it('uses the configured interval and limits each queue batch to 20 jobs', async () => {
      vi.useFakeTimers();
      const lifecycleQueue = makeSweepQueue([], 'lifecycle');
      const collectionQueue = makeSweepQueue([], 'collection');
      const sup = new BullmqSupervisorService(makeLoggerSpy().logger);

      sup.start(makeIdleWorker, makeIdleWorker, lifecycleQueue.queue, collectionQueue.queue, 7);
      await vi.advanceTimersByTimeAsync(0);

      expect(lifecycleQueue.zrangebyscore).toHaveBeenCalledOnce();
      expect(collectionQueue.zrangebyscore).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(7_000);
      expect(lifecycleQueue.zrangebyscore).toHaveBeenCalledTimes(2);
      expect(collectionQueue.zrangebyscore).toHaveBeenCalledTimes(2);

      sup.requestShutdown();
      await sup.waitForShutdown();
    });

    it('logs promotion races at debug level and other failures at error level', async () => {
      vi.useFakeTimers();
      const { logger, debug, error } = makeLoggerSpy();
      const raceError = new Error('Job race is not in the delayed state. promote');
      const failure = new Error('Redis unavailable');
      const queue = makeSweepQueue([
        makeDelayedJob(vi.fn(async () => Promise.reject(raceError)), 'race'),
        makeDelayedJob(vi.fn(async () => Promise.reject(failure)), 'failure'),
      ]);
      const sup = new BullmqSupervisorService(logger);

      sup.start(makeIdleWorker, makeIdleWorker, queue.queue, makeSweepQueue().queue, SWEEP_INTERVAL_MS / 1000);
      await vi.advanceTimersByTimeAsync(0);

      expect(debug).toHaveBeenCalledWith(expect.stringContaining(raceError.message));
      expect(error).toHaveBeenCalledWith(expect.stringContaining(failure.message));

      sup.requestShutdown();
      await sup.waitForShutdown();
    });

    it('closes both sweep queues during shutdown', async () => {
      vi.useFakeTimers();
      const lifecycleQueue = makeSweepQueue([], 'lifecycle');
      const collectionQueue = makeSweepQueue([], 'collection');
      const sup = new BullmqSupervisorService(makeLoggerSpy().logger);

      sup.start(
        makeIdleWorker,
        makeIdleWorker,
        lifecycleQueue.queue,
        collectionQueue.queue,
        SWEEP_INTERVAL_MS / 1000,
      );
      await vi.advanceTimersByTimeAsync(0);
      await sup.onModuleDestroy();

      expect(lifecycleQueue.close).toHaveBeenCalledOnce();
      expect(collectionQueue.close).toHaveBeenCalledOnce();
    });

    it('limits shutdown waits for blocked sweep commands and queue closes', async () => {
      vi.useFakeTimers();
      const lifecycleQueue = makeSweepQueue([], 'lifecycle');
      lifecycleQueue.zrangebyscore.mockImplementation(async () => new Promise(() => {}));
      lifecycleQueue.close.mockImplementation(async () => new Promise(() => {}));
      const sup = new BullmqSupervisorService(makeLoggerSpy().logger);

      sup.start(
        makeIdleWorker,
        makeIdleWorker,
        lifecycleQueue.queue,
        makeSweepQueue().queue,
        SWEEP_INTERVAL_MS / 1000,
      );
      await vi.advanceTimersByTimeAsync(0);
      const shutdown = sup.onModuleDestroy();
      await vi.advanceTimersByTimeAsync(CLOSE_TIMEOUT_MS);
      await shutdown;

      expect(sup.isShuttingDown()).toBe(true);
    });
  });

  describe('runWithRestart loop', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('recreates a crashed worker via factory() after RESTART_DELAY_MS, force-closes it, and logs CRASHED', async () => {
      vi.useFakeTimers();
      const { logger, error } = makeLoggerSpy();
      const sup = new BullmqSupervisorService(logger);

      const crashClose = vi.fn(async () => {});
      const crashError = new Error('boom');
      const crashedWorker: SupervisedWorker = {
        async run() {
          throw crashError;
        },
        close: crashClose,
      };
      const idle = makeIdleWorker();

      const factory = vi.fn<WorkerFactory>().mockReturnValueOnce(crashedWorker).mockReturnValue(idle);
      const idleFactory: WorkerFactory = () => makeIdleWorker();

      sup.start(factory, idleFactory, makeSweepQueue().queue, makeSweepQueue().queue, SWEEP_INTERVAL_MS / 1000);

      await vi.advanceTimersByTimeAsync(0);
      expect(crashClose).toHaveBeenCalledWith(true);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('CRASHED'));
      expect(error).toHaveBeenCalledWith(expect.stringContaining('boom'));
      expect(factory).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
      expect(factory).toHaveBeenCalledTimes(2);

      sup.requestShutdown();
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
      await sup.waitForShutdown();
    });

    it('exits the restart loop (no further factory calls) when shutdown is requested during the delay', async () => {
      vi.useFakeTimers();
      const sup = new BullmqSupervisorService(makeLoggerSpy().logger);

      const exitClose = vi.fn(async () => {});
      const exitingWorker: SupervisedWorker = {
        async run() {},
        close: exitClose,
      };
      const factory = vi.fn<WorkerFactory>().mockReturnValueOnce(exitingWorker).mockReturnValue(makeIdleWorker());
      const idleFactory: WorkerFactory = () => makeIdleWorker();

      sup.start(factory, idleFactory, makeSweepQueue().queue, makeSweepQueue().queue, SWEEP_INTERVAL_MS / 1000);

      await vi.advanceTimersByTimeAsync(0);
      expect(factory).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS / 2);
      sup.requestShutdown();
      await vi.advanceTimersByTimeAsync(RESTART_DELAY_MS);
      await sup.waitForShutdown();

      expect(factory).toHaveBeenCalledTimes(1);
    });
  });
});
