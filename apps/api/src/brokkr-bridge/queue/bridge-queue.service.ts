import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { type Aad } from '@repo/crypto';
import { type ObservableGaugeCallback, getBullMqTelemetry, getTelemetryMeter } from '@repo/telemetry';
import { type JobsOptions, Job, Queue } from 'bullmq';
import { Buffer } from 'node:buffer';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { type RedisTransportConnectionConfig, REDIS_CONFIG } from 'src/common/redis';
import { type EnvelopeJson, SealedEnvelopeService } from 'src/crypto/sealed-envelope.service';
import { isSealedEnvelope } from 'src/crypto/sealed-envelope.types';
import { LoggerService } from 'src/logger/logger.service';
import { COLLECTION_QUEUE_NAME, LIFECYCLE_QUEUE_NAME, QUEUE_JOB_STATES } from '../constants/queue.constants';
import { type SagaJobData, type SagaName, JOB_NAME } from './bridge-queue.types';

export type LifecycleJobData = SagaJobData | EnvelopeJson;

@Injectable()
export class BridgeQueueService implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue<LifecycleJobData>>();
  private readonly collectionQueues = new Map<string, Queue>();

  private readonly queueJobs = getTelemetryMeter('brokkr-hub').createObservableGauge('brokkr.queue.jobs', {
    description: 'BullMQ job counts by queue and state',
  });

  // Stored so onModuleDestroy can unregister it before the queues close.
  private readonly observeQueueJobs: ObservableGaugeCallback = async (observable) => {
    await Promise.all(
      [...this.queues.entries()].map(async ([zoneId, queue]) => {
        try {
          const counts = await queue.getJobCounts(...QUEUE_JOB_STATES);
          for (const state of QUEUE_JOB_STATES) {
            observable.observe(counts[state] ?? 0, { queue: `zone:${zoneId}`, state });
          }
        } catch (error) {
          // Per-queue isolation: one unreachable zone queue must not drop the
          // others' counts or fail the collection cycle.
          this.logger.debug(`queue.jobs gauge: failed to read counts for zone ${zoneId}: ${getErrorMessage(error)}`);
        }
      }),
    );
  };

  constructor(
    @Inject(REDIS_CONFIG) private readonly redisConfig: RedisTransportConnectionConfig,
    private readonly sealedEnvelope: SealedEnvelopeService,
    @Logger(BridgeQueueService.name) private readonly logger: LoggerService,
  ) {
    this.queueJobs.addCallback(this.observeQueueJobs);
  }

  isZoneEnrolled(zoneId: string): Promise<boolean> {
    return this.sealedEnvelope.isZoneEnrolled(zoneId);
  }

  getLifecycleQueue(zonePrefix: string): Queue<LifecycleJobData> {
    const existing = this.queues.get(zonePrefix);
    if (existing) return existing;

    const queue = new Queue<LifecycleJobData>(LIFECYCLE_QUEUE_NAME, {
      prefix: zonePrefix,
      connection: { ...this.redisConfig },
      // Trace propagation rides job.opts.telemetry, never job.data (the bridge's strict saga-payload validation only sees job.data.payload).
      telemetry: getBullMqTelemetry('brokkr-hub'),
    });

    this.queues.set(zonePrefix, queue);
    this.logger.log(`Created lifecycle queue for zone prefix: ${zonePrefix}`);
    return queue;
  }

  // The bridge's collection queue (enrich → collection.run lands here). Read-only from the hub;
  // used by commissioning cancel to sweep abandoned enrich jobs the lifecycle sweep can't reach.
  getCollectionQueue(zonePrefix: string): Queue {
    const existing = this.collectionQueues.get(zonePrefix);
    if (existing) return existing;

    const queue = new Queue(COLLECTION_QUEUE_NAME, {
      prefix: zonePrefix,
      connection: { ...this.redisConfig },
    });

    this.collectionQueues.set(zonePrefix, queue);
    this.logger.log(`Created collection queue for zone prefix: ${zonePrefix}`);
    return queue;
  }

  // zoneId doubles as the BullMQ queue prefix (must match the bridge's BROKKR_ZONE_ID); coalesceKey caps work at one waiting/active job per key, best-effort — a worker can activate the job between getState() and remove(), and the next tick recovers.
  async enqueueSagaJob(
    zoneId: string,
    sagaName: SagaName,
    planId: string,
    payload: Record<string, unknown>,
    deviceId: string,
    opts?: Pick<JobsOptions, 'removeOnComplete' | 'removeOnFail'> & { coalesceKey?: string; idempotent?: boolean },
  ): Promise<Job<LifecycleJobData>> {
    const queue = this.getLifecycleQueue(zoneId);

    const bullmqJobId = opts?.coalesceKey ?? `${deviceId}-${sagaName}-${planId}`;

    const existing = await queue.getJob(bullmqJobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'active') {
        // remove() throws on active, so no re-seal here; a stale-format job gets rejected by the bridge, fails, and the next enqueue re-seals it.
        this.logger.log(`Skipping enqueue of ${sagaName} for ${deviceId}: job ${bullmqJobId} already active`, planId);
        return existing;
      }
      // Re-seal a not-yet-started job whose seal format no longer matches the zone's activation state — the activated bridge would reject the stale-format payload.
      if (opts?.idempotent && state !== 'failed') {
        const notStarted = state !== 'completed';
        const formatStale =
          notStarted && isSealedEnvelope(existing.data) !== (await this.sealedEnvelope.isZoneEnrolled(zoneId));
        if (!formatStale) {
          this.logger.log(
            `Idempotent enqueue of ${sagaName} for ${deviceId}: returning existing ${state} job ${bullmqJobId}`,
            planId,
          );
          return existing;
        }
        this.logger.log(
          `Re-sealing stale-format ${sagaName} job ${bullmqJobId} for ${deviceId}: zone activation changed since enqueue`,
          planId,
        );
      }
    }

    const sagaData: SagaJobData = {
      plan_id: planId,
      saga_name: sagaName,
      payload,
      device_id: deviceId,
    };
    // Seal BEFORE removing the existing job: a fail-closed seal throw after remove() would delete the job with no replacement.
    const jobData = await this.resolveOutboundData(zoneId, sagaName, planId, sagaData);

    if (existing) {
      await existing.remove();
    }

    const job = await queue.add(JOB_NAME.SAGA_RUN, jobData, {
      jobId: bullmqJobId,
      attempts: 2,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: opts?.removeOnComplete ?? { count: 1000 },
      removeOnFail: opts?.removeOnFail ?? { count: 5000 },
    });

    this.logger.log(`Enqueued ${sagaName} saga to ${zoneId}: planId=${planId}, deviceId=${deviceId}`, planId);
    return job;
  }

  // Enrolled zones FAIL CLOSED: sealHubToBridge throws on a dormant hub key rather than downgrading the zone's BMC creds to plaintext; the enroll-window race is retry-safe (bridge raises key-unknown, BullMQ retries).
  private async resolveOutboundData(
    zoneId: string,
    sagaName: SagaName,
    planId: string,
    sagaData: SagaJobData,
  ): Promise<LifecycleJobData> {
    if (!(await this.sealedEnvelope.isZoneEnrolled(zoneId))) {
      this.logger.log(
        `zone-crypto: enqueuing PLAINTEXT hub→bridge payload (unencrypted creds; zone not enrolled) zone=${zoneId} saga=${sagaName}`,
        planId,
      );
      return sagaData;
    }

    const aadFields: Aad = {
      aad_v: 1,
      zone_id: zoneId,
      queue_name: LIFECYCLE_QUEUE_NAME,
      direction: 'hub_to_bridge',
      job_id: planId,
      created_at: Date.now(),
    };
    const plaintext = Buffer.from(JSON.stringify(sagaData), 'utf8');
    const envelope = await this.sealedEnvelope.sealHubToBridge(zoneId, plaintext, aadFields);
    this.logger.log(
      `zone-crypto: sealing hub→bridge payload (encrypted creds) zone=${zoneId} saga=${sagaName}`,
      planId,
    );
    return envelope;
  }

  async onModuleDestroy() {
    this.queueJobs.removeCallback(this.observeQueueJobs);
    await Promise.all(
      [...this.queues.entries()].map(async ([prefix, queue]) => {
        await queue.close();
        this.logger.log(`Closed lifecycle queue for zone prefix: ${prefix}`);
      }),
    );
    this.queues.clear();
    await Promise.all(
      [...this.collectionQueues.entries()].map(async ([prefix, queue]) => {
        await queue.close();
        this.logger.log(`Closed collection queue for zone prefix: ${prefix}`);
      }),
    );
    this.collectionQueues.clear();
  }
}
