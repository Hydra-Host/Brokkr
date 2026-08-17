import { readFileSync } from 'node:fs';

import { getBullMqTelemetry, getTelemetryMeter } from '@repo/telemetry';
import {
  Queue as BullmqLibQueue,
  Worker as BullmqWorker,
  WaitingChildrenError,
  type Job,
  type QueueOptions,
} from 'bullmq';

import { awaitBullmqProcessor } from '../bullmq/bullmq-processor-singleton.js';
import { BullmqSupervisorService, type SupervisedWorker } from '../bullmq/bullmq-supervisor.service.js';
import { getBullmqConfig, type BullmqConfig } from '../bullmq/bullmq.config.js';
import { CrossBridgeHandoff, type ProcessableJob } from '../bullmq/handlers.service.js';
import type { BullmqQueue, BullmqQueueFactory, QueueCreateOptions, SharedOpsClient } from '../bullmq/queue.service.js';
import { BullmqQueueService } from '../bullmq/queue.service.js';
import type { CountableQueue } from '../bullmq/registry.service.js';
import type {
  EnqueueRenderRequestArgs,
  RenderRequestQueue,
  ResultsQueueProvider,
  ZoneCryptoStateProvider,
  ZoneIdProvider,
} from '../bullmq/render-request.service.js';
import { BullmqRenderRequestService } from '../bullmq/render-request.service.js';
import { getErrorMessage } from '../common/error-utils.js';
import type { RedisConfig } from '../common/redis/redis-client/redis.config.js';
import { loadRedisConfig } from '../common/redis/redis-client/redis.config.js';
import type { EnqueueRenderRequest } from '../device-record/atom/atom-fetcher.js';
import { logDebug } from '../logger/logger.service.js';
import { ZoneCryptoService } from '../zone-crypto/zone-crypto.service.js';

export function createBullmqSupervisor(): BullmqSupervisorService {
  return new BullmqSupervisorService();
}

const QUEUE_JOB_STATES = ['waiting', 'active', 'failed', 'delayed'] as const;

// Register the queue-depth gauge once; its callback reads every tracked source per tick.
// Sources keyed by name so a rebuilt handle replaces its predecessor (bounded: lifecycle/collection/results).
export function createQueueJobsMetrics(): { track(queueName: string, queue: CountableQueue): void } {
  const sources = new Map<string, CountableQueue>();
  let gaugeRegistered = false;
  return {
    track(queueName, queue) {
      sources.set(queueName, queue);
      if (gaugeRegistered) return;
      gaugeRegistered = true;
      getTelemetryMeter('brokkr-bridge')
        .createObservableGauge('brokkr.queue.jobs', {
          description: 'BullMQ job counts seen by this bridge, by queue and state',
        })
        .addCallback(async (result) => {
          for (const [name, source] of sources) {
            try {
              const counts = await source.getJobCounts(...QUEUE_JOB_STATES);
              for (const state of QUEUE_JOB_STATES) {
                result.observe(counts[state] ?? 0, { queue: name, state });
              }
            } catch (error) {
              // A closed/unreachable queue must not fail the whole collection; log at debug so a
              // persistently broken queue still leaves a breadcrumb (matching the hub's gauges).
              void logDebug(`brokkr.queue.jobs gauge: failed to read counts for '${name}': ${getErrorMessage(error)}`);
            }
          }
        });
    },
  };
}

const queueJobsMetrics = createQueueJobsMetrics();

export function trackQueueForMetrics(queueName: string, queue: CountableQueue): void {
  queueJobsMetrics.track(queueName, queue);
}

export function createRealBullmqQueueFactory(): BullmqQueueFactory {
  return {
    createSharedOpsClient(): SharedOpsClient {
      const connection = toBullmqConnection(loadRedisConfig());
      return { ...connection, aclose: async () => undefined } as unknown as SharedOpsClient;
    },
    createQueue(queueName: string, options: QueueCreateOptions): BullmqQueue {
      const queue = new BullmqLibQueue(queueName, {
        prefix: options.prefix,
        connection: options.connection,
        // Trace propagation rides on job.opts.telemetry; job.data untouched, so hub results parsing never sees it.
        telemetry: getBullMqTelemetry('brokkr-bridge'),
      } as unknown as QueueOptions);
      trackQueueForMetrics(queueName, queue);
      return {
        add: (name, data, opts) => queue.add(name, data, opts),
        remove: async (jobId) => {
          await queue.remove(jobId);
        },
        getJobState: async (jobId) => {
          const job = await queue.getJob(jobId);
          return job === undefined ? null : job.getState();
        },
        getQueuedJobs: async () => {
          const jobs = await queue.getJobs(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);
          return jobs.map((job) => ({ id: job.id ?? null, data: job.data }));
        },
        close: () => queue.close(),
      };
    },
  };
}

interface BullmqRedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: object;
  db?: number;
  maxRetriesPerRequest: null;
}

function toBullmqConnection(config: RedisConfig): BullmqRedisConnectionOptions {
  const opts: BullmqRedisConnectionOptions = {
    host: config.host,
    port: config.port,
    password: config.password,
    db: config.db,
    maxRetriesPerRequest: null,
  };
  if (config.username) opts.username = config.username;
  // mirror ioredis-driver buildRedisOptions: a private CA must be loaded or rediss:// fails verification.
  if (config.tls) opts.tls = config.tlsCaCert ? { ca: readFileSync(config.tlsCaCert) } : {};
  return opts;
}

function adaptBullmqJob(job: Job): ProcessableJob<unknown> {
  const scripts = (job as unknown as { scripts: ProcessableJob<unknown>['scripts'] }).scripts;
  return {
    id: job.id ?? null,
    name: job.name,
    data: job.data,
    queue: {
      name: job.queueName,
      opts: (job as unknown as { queue?: { opts?: unknown } }).queue?.opts,
    },
    scripts,
  };
}

async function dispatchToProcessor(job: Job, token?: string): Promise<unknown> {
  const processor = await awaitBullmqProcessor();
  const adapted = adaptBullmqJob(job);
  try {
    const result = await processor.process(adapted, token ?? '');
    (job as unknown as { data: unknown }).data = adapted.data;
    return result;
  } catch (exc) {
    if (exc instanceof CrossBridgeHandoff) {
      throw new WaitingChildrenError(exc.message);
    }
    throw exc;
  }
}

interface WorkerFactoryDeps {
  config?: BullmqConfig;
  redisConfig?: RedisConfig;
  workerCtor?: typeof BullmqWorker;
}

interface SweepQueueFactoryDeps {
  config?: BullmqConfig;
  redisConfig?: RedisConfig;
  queueCtor?: typeof BullmqLibQueue;
}

function buildDelayedJobSweepQueue(queueName: string, deps: SweepQueueFactoryDeps): BullmqLibQueue {
  const config = deps.config ?? getBullmqConfig();
  const redisConfig = deps.redisConfig ?? loadRedisConfig();
  const QueueCtor = deps.queueCtor ?? BullmqLibQueue;
  return new QueueCtor(queueName, {
    prefix: config.bullmqPrefix,
    connection: toBullmqConnection(redisConfig),
    telemetry: getBullMqTelemetry('brokkr-bridge'),
  } as unknown as QueueOptions);
}

export function createLifecycleSweepQueue(deps: SweepQueueFactoryDeps = {}): BullmqLibQueue {
  const config = deps.config ?? getBullmqConfig();
  return buildDelayedJobSweepQueue(config.bullmqQueueName, { ...deps, config });
}

export function createCollectionSweepQueue(deps: SweepQueueFactoryDeps = {}): BullmqLibQueue {
  const config = deps.config ?? getBullmqConfig();
  return buildDelayedJobSweepQueue(config.collectionQueueName, { ...deps, config });
}

function buildSupervisedWorker(queueName: string, concurrency: number, deps: WorkerFactoryDeps): SupervisedWorker {
  const config = deps.config ?? getBullmqConfig();
  const redisConfig = deps.redisConfig ?? loadRedisConfig();
  const WorkerCtor = deps.workerCtor ?? BullmqWorker;

  const worker = new WorkerCtor(queueName, dispatchToProcessor, {
    prefix: config.bullmqPrefix,
    connection: toBullmqConnection(redisConfig),
    concurrency,
    autorun: false,
    lockDuration: config.bullmqLockDurationMs,
    lockRenewTime: config.bullmqLockRenewTimeMs,
    maxStalledCount: config.bullmqMaxStalledCount,
    stalledInterval: config.bullmqStalledIntervalMs,
    drainDelay: 1,
    telemetry: getBullMqTelemetry('brokkr-bridge'),
  });

  return {
    run: () => worker.run(),
    close: (force?: boolean) => worker.close(force),
  };
}

export function createLifecycleWorker(deps: WorkerFactoryDeps = {}): SupervisedWorker {
  const config = deps.config ?? getBullmqConfig();
  return buildSupervisedWorker(config.bullmqQueueName, config.lifecycleWorkerConcurrency, {
    ...deps,
    config,
  });
}

export function createCollectionWorker(deps: WorkerFactoryDeps = {}): SupervisedWorker {
  const config = deps.config ?? getBullmqConfig();
  return buildSupervisedWorker(config.collectionQueueName, config.collectionWorkerConcurrency, {
    ...deps,
    config,
  });
}

function buildResultsQueueProvider(queueService: BullmqQueueService): ResultsQueueProvider {
  return {
    async getResultsQueue(): Promise<RenderRequestQueue | null> {
      const queue = await queueService.getResultsQueue();
      if (queue === null) return null;
      return {
        name: getBullmqConfig().resultsQueueName,
        add: (name, data, opts) =>
          queue.add(name, data as Record<string, unknown>, opts as unknown as Parameters<typeof queue.add>[2]),
      };
    },
    resetSharedOpsStateOnConnectionError: (exc) => queueService.resetSharedOpsStateOnConnectionError(exc),
  };
}

function buildZoneIdProvider(env: NodeJS.ProcessEnv): ZoneIdProvider {
  return {
    getZoneId: () => (env.BROKKR_ZONE_ID ?? '').trim(),
  };
}

function buildZoneCryptoStateProvider(zoneCrypto: ZoneCryptoService, zoneId: ZoneIdProvider): ZoneCryptoStateProvider {
  return {
    getZoneCryptoState: () => {
      const snapshot = zoneCrypto.get();
      if (snapshot === null) return null;
      return {
        zonePriv: snapshot.zonePriv,
        hubPub: snapshot.hubPub,
        zoneId: zoneId.getZoneId(),
      };
    },
  };
}

export function createRenderRequestEnqueuer(
  queueService: BullmqQueueService,
  zoneCrypto: ZoneCryptoService,
  env: NodeJS.ProcessEnv = process.env,
): EnqueueRenderRequest {
  const zoneId = buildZoneIdProvider(env);
  const service = new BullmqRenderRequestService(
    buildResultsQueueProvider(queueService),
    zoneId,
    buildZoneCryptoStateProvider(zoneCrypto, zoneId),
  );
  return async (params) => {
    const args: EnqueueRenderRequestArgs = {
      requestId: params.requestId,
      domain: params.domain,
      bridgeId: params.bridgeId,
      entityId: params.entityId,
      params: params.params as Record<string, unknown> | null | undefined,
      reason: params.reason,
    };
    return service.enqueueRenderRequest(args);
  };
}

export function createCollectionJobEnqueuer(
  queueService: BullmqQueueService,
): (args: { deviceId: string; jobId?: string }) => Promise<boolean> {
  return (args) => queueService.enqueueCollectionJob(args);
}
