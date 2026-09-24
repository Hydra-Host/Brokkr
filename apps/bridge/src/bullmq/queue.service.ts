import { randomUUID } from 'node:crypto';
import { getErrorMessage } from '../common/error-utils';

import { Inject, Injectable, Optional, type OnModuleDestroy } from '@nestjs/common';
import { isRecord } from '@repo/utils';

import { loadRedisConfig } from '../common/redis/redis-client';
import { ContextLogger } from '../logger/logger.service';
import { PLAN_PERSISTER_PROVIDER, type PlanPersisterProvider } from '../saga-framework/plan-manager-holder';
import { ZoneCryptoService } from '../zone-crypto/zone-crypto.service';

import { sealBridgeLocalJob } from './bridge-local-sig';
import { getBullmqConfig } from './bullmq.config';
import { EPHEMERAL_SAGAS, JOB_NAME, type CollectionJobData, type SagaJobData } from './bullmq.types';
import { makeJobId } from './job-id';

export interface JobAddOptions {
  jobId: string;
  attempts: number;
  backoff: { type: string; delay: number };
  removeOnComplete: { count: number };
  removeOnFail: { count: number };
}

export interface BullmqQueue {
  add(name: string, data: Record<string, unknown>, opts: JobAddOptions): Promise<unknown>;
  remove?(jobId: string): Promise<void>;
  getJobState?(jobId: string): Promise<string | null>;
  getQueuedJobs?(): Promise<Array<{ id: string | null; data: unknown }>>;
  close(): Promise<void>;
}

export interface SharedOpsClient {
  aclose(): Promise<void>;
}

export interface QueueCreateOptions {
  prefix: string;
  connection: SharedOpsClient;
}

export interface BullmqQueueFactory {
  createSharedOpsClient(): SharedOpsClient;
  createQueue(queueName: string, options: QueueCreateOptions): BullmqQueue;
}

export const BULLMQ_QUEUE_FACTORY = Symbol('BULLMQ_QUEUE_FACTORY');

export interface RedisConnectionOpts {
  host: string;
  port: number;
  db: number;
  socketTimeout: number;
  socketConnectTimeout: number;
  username?: string;
  password?: string;
  tls?: boolean;
  tlsCaCert?: string;
}

const LIVE_JOB_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === 'RedisConnectionError') return true;
  if (error.name === 'ConnectionError') return true;
  const code = (error as { code?: string }).code;
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && /not found|does not exist/i.test(error.message);
}

@Injectable()
export class BullmqQueueService implements OnModuleDestroy {
  private readonly logger: ContextLogger;

  private lifecycleQueue: BullmqQueue | null = null;
  private collectionQueue: BullmqQueue | null = null;
  private resultsQueue: BullmqQueue | null = null;
  private sharedOpsClient: SharedOpsClient | null = null;

  constructor(
    @Optional() @Inject(BULLMQ_QUEUE_FACTORY) private readonly factory?: BullmqQueueFactory,
    @Optional() logger?: ContextLogger,
    @Optional() private readonly zoneCrypto?: ZoneCryptoService,
    @Optional() @Inject(PLAN_PERSISTER_PROVIDER) private readonly planPersisterProvider?: PlanPersisterProvider,
  ) {
    this.logger = logger ?? new ContextLogger();
  }

  getSharedOpsClient(): SharedOpsClient | null {
    if (this.sharedOpsClient === null) {
      if (this.factory === undefined) return null;
      this.sharedOpsClient = this.factory.createSharedOpsClient();
    }
    return this.sharedOpsClient;
  }

  async resetSharedOpsState(): Promise<void> {
    const oldQueues = [this.lifecycleQueue, this.collectionQueue, this.resultsQueue].filter(
      (q): q is BullmqQueue => q !== null,
    );
    this.lifecycleQueue = null;
    this.collectionQueue = null;
    this.resultsQueue = null;

    const oldClient = this.sharedOpsClient;
    this.sharedOpsClient = null;

    for (const old of oldQueues) {
      try {
        await old.close();
      } catch (error) {
        void this.logger.debug(`BullMQ queue close failed during reset: ${getErrorMessage(error)}`);
      }
    }

    if (oldClient !== null) {
      try {
        await oldClient.aclose();
      } catch (error) {
        void this.logger.debug(`BullMQ shared ops client close failed during reset: ${getErrorMessage(error)}`);
      }
    }
  }

  async closeSharedOpsClientIfPresent(): Promise<void> {
    const oldClient = this.sharedOpsClient;
    this.sharedOpsClient = null;
    if (oldClient !== null) {
      try {
        await oldClient.aclose();
      } catch (error) {
        void this.logger.debug(`BullMQ shared ops client close failed: ${getErrorMessage(error)}`);
      }
    }
  }

  clearCachedQueueHandles(): void {
    this.lifecycleQueue = null;
    this.collectionQueue = null;
    this.resultsQueue = null;
  }

  async resetSharedOpsStateOnConnectionError(exc: unknown): Promise<boolean> {
    if (isConnectionError(exc)) {
      await this.resetSharedOpsState();
      return true;
    }
    return false;
  }

  getRedisConnectionOpts(): RedisConnectionOpts {
    const config = loadRedisConfig();
    const opts: RedisConnectionOpts = {
      host: config.host,
      port: config.port,
      db: config.db,
      socketTimeout: config.socketTimeout,
      socketConnectTimeout: config.socketConnectTimeout,
    };
    if (config.username) opts.username = config.username;
    if (config.password) opts.password = config.password;
    if (config.tls) {
      opts.tls = true;
      if (config.tlsCaCert) opts.tlsCaCert = config.tlsCaCert;
    }
    return opts;
  }

  private getOrCreateQueue(queueName: string): BullmqQueue | null {
    if (this.factory === undefined) return null;
    const connection = this.getSharedOpsClient();
    if (connection === null) return null;
    try {
      return this.factory.createQueue(queueName, {
        prefix: getBullmqConfig().bullmqPrefix,
        connection,
      });
    } catch (exc) {
      void this.logger.warning(`Failed to initialize BullMQ queue '${queueName}': ${getErrorMessage(exc)}`);
      return null;
    }
  }

  async getLifecycleQueue(): Promise<BullmqQueue | null> {
    if (this.lifecycleQueue !== null) return this.lifecycleQueue;
    this.lifecycleQueue = this.getOrCreateQueue(getBullmqConfig().bullmqQueueName);
    return this.lifecycleQueue;
  }

  async getCollectionQueue(): Promise<BullmqQueue | null> {
    if (this.collectionQueue !== null) return this.collectionQueue;
    this.collectionQueue = this.getOrCreateQueue(getBullmqConfig().collectionQueueName);
    return this.collectionQueue;
  }

  async getResultsQueue(): Promise<BullmqQueue | null> {
    if (this.resultsQueue !== null) return this.resultsQueue;
    if (this.factory === undefined) return null;
    const connection = this.getSharedOpsClient();
    if (connection === null) return null;
    const config = getBullmqConfig();
    try {
      this.resultsQueue = this.factory.createQueue(config.resultsQueueName, {
        prefix: config.resultsQueuePrefix,
        connection,
      });
      return this.resultsQueue;
    } catch (exc) {
      void this.logger.warning(`Failed to initialize results queue: ${getErrorMessage(exc)}`);
      return null;
    }
  }

  async enqueueSagaJob(args: {
    planId: string;
    sagaName: string;
    payload: Record<string, unknown>;
    deviceId: string | number;
    bridgeLocal?: boolean;
    removeExisting?: boolean;
  }): Promise<boolean> {
    const queue = await this.getLifecycleQueue();
    if (queue === null) return false;
    if (queue.getJobState === undefined || queue.remove === undefined) return false;

    const config = getBullmqConfig();
    const jobId = makeJobId(args.deviceId, `${args.sagaName}-${args.planId}`);

    const ephemeral = EPHEMERAL_SAGAS.has(args.sagaName);
    const retainComplete = ephemeral ? 3 : 100;
    const retainFail = ephemeral ? 10 : 500;
    const deviceId = String(args.deviceId);
    let data: Record<string, unknown> = {
      plan_id: args.planId,
      saga_name: args.sagaName,
      payload: args.payload,
      device_id: deviceId,
    } satisfies SagaJobData;
    if (args.bridgeLocal) {
      const zone = this.zoneCrypto?.get();
      if (zone !== undefined && zone !== null) {
        data = sealBridgeLocalJob(zone.zonePriv, data, {
          job_id: jobId,
          job_name: JOB_NAME.SAGA_RUN,
          queue_name: config.bullmqQueueName,
        });
      } else {
        data.__bridge_local = true;
      }
    }

    try {
      const state = await queue.getJobState(jobId);
      if (state !== null && LIVE_JOB_STATES.has(state)) return true;
      if (state !== null || args.removeExisting) {
        try {
          await queue.remove(jobId);
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        }
      }
      // A bridge-local saga's worker fails closed if its plan isn't already in Redis (it refuses to
      // rebuild device-mutating steps), so persist the plan before the job becomes consumable.
      if (args.bridgeLocal) {
        const persisted = await this.ensureBridgeLocalPlanPersisted(
          args.planId,
          args.sagaName,
          deviceId,
          config.bullmqQueueName,
        );
        if (!persisted) return false;
      }
      await queue.add(JOB_NAME.SAGA_RUN, data, {
        jobId,
        attempts: config.bullmqRetries + 1,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: retainComplete },
        removeOnFail: { count: retainFail },
      });
      return true;
    } catch (exc) {
      await this.resetSharedOpsStateOnConnectionError(exc);
      void this.logger.warning(
        `Failed to enqueue saga '${args.sagaName}' for device ${args.deviceId}: ${getErrorMessage(exc)}`,
      );
      return false;
    }
  }

  private async ensureBridgeLocalPlanPersisted(
    planId: string,
    sagaName: string,
    deviceId: string,
    queueName: string,
  ): Promise<boolean> {
    const pm = this.planPersisterProvider?.() ?? null;
    if (pm === null) {
      void this.logger.warning(
        `No PlanManager wired; cannot persist bridge-local plan ${planId} for '${sagaName}' — skipping enqueue to avoid a fail-closed job`,
      );
      return false;
    }
    try {
      const persisted = await pm.persistInitialPlan(planId, sagaName, deviceId, queueName);
      if (!persisted) {
        void this.logger.warning(`Could not persist bridge-local plan ${planId} for '${sagaName}' — skipping enqueue`);
      }
      return persisted;
    } catch (exc) {
      void this.logger.warning(
        `Failed to persist bridge-local plan ${planId} for '${sagaName}': ${getErrorMessage(exc)}`,
      );
      return false;
    }
  }

  async jobExistsInQueue(jobId: string, planId?: string): Promise<boolean> {
    try {
      const queue = await this.getLifecycleQueue();
      if (queue === null) return true;
      if (queue.getJobState === undefined) return true;
      const state = await queue.getJobState(jobId);
      if (state !== null && LIVE_JOB_STATES.has(state)) return true;
      if (planId === undefined || queue.getQueuedJobs === undefined) return false;
      const jobs = await queue.getQueuedJobs();
      return jobs.some((job) => isRecord(job.data) && String(job.data.plan_id ?? '') === planId);
    } catch (error) {
      void this.logger.warning(`Failed to check for BullMQ job ${jobId}: ${getErrorMessage(error)}`);
      return true;
    }
  }

  async enqueueCollectionJob(args: { deviceId: string | number; jobId?: string }): Promise<boolean> {
    const queue = await this.getCollectionQueue();
    if (queue === null) {
      void this.logger.warning('Collection queue unavailable, skipping enqueue');
      return false;
    }

    const dedupId = makeJobId(args.deviceId, 'inventory_collection');
    const planId = randomUUID();

    try {
      await queue.add(
        JOB_NAME.COLLECTION_RUN,
        {
          device_id: String(args.deviceId),
          plan_id: planId,
          job_id: args.jobId || planId,
          saga_name: 'inventory_collection',
        } satisfies CollectionJobData,
        {
          jobId: dedupId,
          attempts: 2,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { count: 3 },
          removeOnFail: { count: 10 },
        },
      );
      void this.logger.info(`Enqueued collection job for device ${args.deviceId} (plan=${planId})`);
      return true;
    } catch (exc) {
      await this.resetSharedOpsStateOnConnectionError(exc);
      void this.logger.warning(`Failed to enqueue collection job for device ${args.deviceId}: ${getErrorMessage(exc)}`);
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.resetSharedOpsState();
  }
}
