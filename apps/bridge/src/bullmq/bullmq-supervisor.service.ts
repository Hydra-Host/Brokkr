import { Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { sleep } from '../common/async/abortable';
import { setShutdownSignal } from '../common/async/shutdown-signal';
import { getErrorMessage } from '../common/error-utils';

import { ContextLogger } from '../logger/logger.service';

export interface SupervisedWorker {
  run(): Promise<void>;
  close(force?: boolean): Promise<void>;
}

export type WorkerFactory = () => SupervisedWorker;

const RESTART_DELAY_MS = 5_000;
const CLOSE_TIMEOUT_MS = 10_000;
const DELAYED_JOB_SWEEP_BATCH_SIZE = 20;

function isPromotionRace(error: unknown): boolean {
  if (!(error instanceof Error) || !error.message.endsWith('. promote')) return false;
  return error.message.includes('is not in the delayed state') || error.message.startsWith('Missing key for job ');
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

@Injectable()
export class BullmqSupervisorService implements OnModuleDestroy {
  private readonly shutdownController = new AbortController();
  private lifecycleTask: Promise<void> | null = null;
  private collectionTask: Promise<void> | null = null;
  private sweepTask: Promise<void> | null = null;
  private sweepQueueCloseTask: Promise<void> | null = null;
  private sweepQueues: Queue[] = [];
  private readonly activeWorkers = new Set<SupervisedWorker>();
  private readonly logger: ContextLogger;

  constructor(@Optional() logger?: ContextLogger) {
    this.logger = logger ?? new ContextLogger();
  }

  requestShutdown(): void {
    if (!this.shutdownController.signal.aborted) {
      this.shutdownController.abort();
      this.forceCloseActiveWorkers();
      this.closeSweepQueues();
    }
  }

  isShuttingDown(): boolean {
    return this.shutdownController.signal.aborted;
  }

  start(
    lifecycleFactory: WorkerFactory,
    collectionFactory: WorkerFactory,
    lifecycleQueue: Queue,
    collectionQueue: Queue,
    delayedPromoteIntervalSeconds: number,
  ): void {
    if (this.lifecycleTask !== null || this.collectionTask !== null) {
      return;
    }
    setShutdownSignal(this.shutdownController.signal);
    this.sweepQueues = [lifecycleQueue, collectionQueue];
    this.lifecycleTask = this.runWithRestart(lifecycleFactory, 'lifecycle');
    this.collectionTask = this.runWithRestart(collectionFactory, 'collection');
    this.sweepTask = this.runDelayedJobSweep(delayedPromoteIntervalSeconds * 1000);
  }

  async waitForShutdown(): Promise<void> {
    await new Promise<void>((resolve) => {
      if (this.shutdownController.signal.aborted) {
        resolve();
        return;
      }
      this.shutdownController.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await this.joinTasks();
  }

  async onModuleDestroy(): Promise<void> {
    this.requestShutdown();
    await this.joinTasks();
    setShutdownSignal(undefined);
  }

  private forceCloseActiveWorkers(): void {
    for (const worker of this.activeWorkers) {
      void withTimeout(worker.close(true), CLOSE_TIMEOUT_MS).catch(() => undefined);
    }
  }

  private closeSweepQueues(): void {
    if (this.sweepQueueCloseTask !== null) return;
    this.sweepQueueCloseTask = Promise.all(
      this.sweepQueues.map(async (queue) => {
        try {
          await withTimeout(queue.close(), CLOSE_TIMEOUT_MS);
        } catch (error) {
          void this.logger.error(`Delayed-job sweep queue '${queue.name}' close failed: ${getErrorMessage(error)}`);
        }
      }),
    ).then(() => undefined);
  }

  private async joinTasks(): Promise<void> {
    const tasks = [
      this.lifecycleTask,
      this.collectionTask,
      this.sweepTask === null ? null : withTimeout(this.sweepTask, CLOSE_TIMEOUT_MS),
      this.sweepQueueCloseTask === null ? null : withTimeout(this.sweepQueueCloseTask, CLOSE_TIMEOUT_MS),
    ].filter((task): task is Promise<void | null> => task !== null);
    await Promise.allSettled(tasks);
    this.lifecycleTask = null;
    this.collectionTask = null;
    this.sweepTask = null;
    this.sweepQueueCloseTask = null;
    this.sweepQueues = [];
  }

  private async runDelayedJobSweep(intervalMs: number): Promise<void> {
    while (!this.shutdownController.signal.aborted) {
      await Promise.all(this.sweepQueues.map((queue) => this.sweepDelayedJobs(queue)));
      await sleep(intervalMs, this.shutdownController.signal);
    }
  }

  private async sweepDelayedJobs(queue: Queue): Promise<void> {
    try {
      const client = await queue.client;
      const delayedKey = queue.toKey('delayed');
      const jobIds = await client.zrangebyscore(
        delayedKey,
        0,
        Date.now() * 0x1000 + 0xfff,
        'LIMIT',
        0,
        DELAYED_JOB_SWEEP_BATCH_SIZE,
      );

      for (const jobId of jobIds) {
        if (this.shutdownController.signal.aborted) break;
        try {
          const job = await queue.getJob(jobId);
          const score = await client.zscore(delayedKey, jobId);
          if (job === undefined || score === null || Number(score) > Date.now() * 0x1000 + 0xfff) continue;
          await job.promote();
        } catch (error) {
          const message = `Failed to promote delayed job '${jobId}' from queue '${queue.name}': ${getErrorMessage(error)}`;
          if (isPromotionRace(error)) {
            void this.logger.debug(message);
          } else {
            void this.logger.error(message);
          }
        }
      }
    } catch (error) {
      if (!this.shutdownController.signal.aborted) {
        void this.logger.error(`Delayed-job sweep failed for queue '${queue.name}': ${getErrorMessage(error)}`);
      }
    }
  }

  private async runWithRestart(factory: WorkerFactory, name: string): Promise<void> {
    while (!this.shutdownController.signal.aborted) {
      let worker: SupervisedWorker | null = null;
      try {
        worker = factory();
        this.activeWorkers.add(worker);
        void this.logger.info(`${name} worker run() starting`);
        await worker.run();
        void this.logger.info(`${name} worker run() exited${this.restartSuffix()}`);
      } catch (exc) {
        void this.logger.error(`${name} worker CRASHED: ${getErrorMessage(exc)}${this.restartSuffix()}`);
      } finally {
        if (worker !== null) {
          this.activeWorkers.delete(worker);
          try {
            await withTimeout(worker.close(true), CLOSE_TIMEOUT_MS);
          } catch (error) {
            void this.logger.debug(`${name} worker close failed: ${getErrorMessage(error)}`);
          }
        }
      }
      await sleep(RESTART_DELAY_MS, this.shutdownController.signal);
    }
  }

  private restartSuffix(): string {
    return this.shutdownController.signal.aborted
      ? ' — not restarting, shutdown requested'
      : ` — restarting in ${RESTART_DELAY_MS / 1_000}s`;
  }
}
