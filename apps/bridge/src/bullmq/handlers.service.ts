import { Injectable, Optional } from '@nestjs/common';
import { getErrorMessage } from '../common/error-utils';

import { isRecord } from '@repo/utils';

import { AgentNotConnected, AgentNotResponsive } from '../agent/dispatch/grpc.exceptions';
import { ContextLogger } from '../logger/logger.service';
import { LOCK_WAIT_STEP_NAME, type StepTransitionEvent } from '../saga-framework/notifications.service';
import { LockLost } from '../saga-framework/saga-runner.service';
import { JobStatus } from '../saga-framework/state.types';
import { ZoneCryptoService } from '../zone-crypto/zone-crypto.service';

import { sealBridgeLocalJob } from './bridge-local-sig';
import {
  AGENT_HANDOFF_REDELAY_SECONDS,
  DeviceLockWaitExceeded,
  EnvelopeDeferralBudgetExceeded,
  HANDOFF_ABANDON_DEADLINE_SECONDS,
  HANDOFF_DEFER_REDIS_KEY_PREFIX,
  HANDOFF_DEFER_REDIS_TTL_SECONDS,
  HandoffAbandoned,
  JOB_NAME,
  LOCK_LOST_REDELAY_SECONDS,
} from './bullmq.types';
import {
  calculateLockWaitTtlSeconds,
  isLockWaitHardCapExceeded,
  lockWaitElapsedSeconds,
  lockWaitRedisKey,
  markLockWaitNotified,
  parseLockWaitState,
  recordLockContention,
  serializeLockWaitState,
  shouldNotifyLockWait,
  type LockWaitState,
} from './lock-wait';
import { FRESHNESS_WINDOW_MS } from './sealed-envelope';

export interface ProcessableJob<T = unknown> {
  id: string | null;
  name: string;
  data: T;
  // Stamped by BullmqProcessorService.process from the opened envelope; absent before processing.
  isBridgeLocal?: boolean;
  queue: { name: string; opts?: unknown };
  scripts: {
    moveToDelayed(
      jobId: string | null,
      timestamp: number,
      delayMs: number,
      token: string,
      opts: {
        fieldsToUpdate?: Record<string, unknown>;
        fetchNext: boolean;
        workerOpts: unknown;
        skipAttempt?: boolean;
      },
    ): Promise<void>;
  };
}

export type JobHandler = (job: ProcessableJob<Record<string, unknown>>, jobToken?: string) => Promise<unknown>;

// Raised after a successful move-to-delayed; the wiring layer MUST catch this and re-throw BullMQ's WaitingChildrenError — BullMQ checks by instanceof, and that's the only exception the worker silently swallows.
export class CrossBridgeHandoff extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrossBridgeHandoff';
  }
}

export class DeviceLockUnavailable extends Error {
  constructor(
    readonly lockKey: string,
    readonly holderInfo: Record<string, string> | null = null,
  ) {
    super(`${lockKey} is locked by another job`);
    this.name = 'DeviceLockUnavailable';
  }
}

function isCrossBridgeError(error: unknown): boolean {
  return error instanceof AgentNotConnected || error instanceof AgentNotResponsive;
}

interface HandoffDeferState {
  first_deferred_at: number;
  attempts: number;
}

function handoffDeferRedisKey(jobKey: string): string {
  return `${HANDOFF_DEFER_REDIS_KEY_PREFIX}:${jobKey}`;
}

function parseHandoffDeferState(raw: string | null): HandoffDeferState | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.first_deferred_at === 'number' && typeof parsed.attempts === 'number') {
      return { first_deferred_at: parsed.first_deferred_at, attempts: parsed.attempts };
    }
  } catch {
    return null;
  }
  return null;
}

export interface InboundEnvelopeOpener {
  open(job: ProcessableJob<unknown>): Promise<{ payload: unknown; createdAtMs: number; isBridgeLocal: boolean }>;
}

export interface LockWaitCache {
  get(key: string, jobId?: string): Promise<string | null>;
  set(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown>;
  delete(key: string, jobId?: string): Promise<number>;
}

export interface LifecyclePlanFailure {
  failPlan(planId: string, error: string): Promise<unknown>;
}

export interface LifecycleNotifications {
  notifyStepTransition(event: StepTransitionEvent): Promise<void>;
}

export interface BullmqProcessorConfig {
  lockWaitWarningSeconds: number;
  lockWaitHardCapSeconds: number;
  lockLostRedelaySeconds: number;
}

export interface BullmqProcessorLogger {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

const DEFAULT_LOCK_WAIT_CACHE: LockWaitCache = {
  get: async () => null,
  set: async () => undefined,
  delete: async () => 0,
};
const DEFAULT_PLAN_FAILURE: LifecyclePlanFailure = {
  failPlan: async () => undefined,
};
const DEFAULT_NOTIFICATIONS: LifecycleNotifications = {
  notifyStepTransition: async () => undefined,
};
const DEFAULT_PROCESSOR_CONFIG: BullmqProcessorConfig = {
  lockWaitWarningSeconds: 60,
  lockWaitHardCapSeconds: 0,
  lockLostRedelaySeconds: LOCK_LOST_REDELAY_SECONDS,
};

@Injectable()
export class BullmqProcessorService {
  private readonly handlers: ReadonlyMap<string, JobHandler>;
  private readonly config: BullmqProcessorConfig;

  constructor(
    handlers: Readonly<Record<string, JobHandler | undefined>>,
    private readonly envelopeOpener: InboundEnvelopeOpener,
    @Optional() private readonly logger: BullmqProcessorLogger = new ContextLogger(),
    configOrLockLostDelay: BullmqProcessorConfig | number = DEFAULT_PROCESSOR_CONFIG,
    private readonly lockWaitCache: LockWaitCache = DEFAULT_LOCK_WAIT_CACHE,
    private readonly planManager: LifecyclePlanFailure = DEFAULT_PLAN_FAILURE,
    private readonly notifications: LifecycleNotifications = DEFAULT_NOTIFICATIONS,
    @Optional() private readonly zoneCrypto?: ZoneCryptoService,
  ) {
    const m = new Map<string, JobHandler>();
    for (const [name, handler] of Object.entries(handlers)) {
      if (handler) m.set(name, handler);
    }
    this.handlers = m;
    this.config =
      typeof configOrLockLostDelay === 'number'
        ? { ...DEFAULT_PROCESSOR_CONFIG, lockLostRedelaySeconds: configOrLockLostDelay / 1_000 }
        : configOrLockLostDelay;
  }

  async process(job: ProcessableJob<unknown>, jobToken: string): Promise<unknown> {
    const { payload, createdAtMs, isBridgeLocal } = await this.envelopeOpener.open(job);
    const mutableJob = job as ProcessableJob<unknown> & { data: unknown };
    mutableJob.data = payload;
    mutableJob.isBridgeLocal = isBridgeLocal;
    if (!isRecord(payload)) {
      const tag = payload === null ? 'null' : Array.isArray(payload) ? 'array' : typeof payload;
      throw new TypeError(`Expected a plain object but received ${tag}`);
    }
    const planIdForLog = String(payload['plan_id'] ?? '');
    await this.logProcessingJob(mutableJob.name, mutableJob.id, planIdForLog);
    const dispatchJob = mutableJob as ProcessableJob<Record<string, unknown>>;
    const lockWaitKey = lockWaitRedisKey(dispatchJob.id ?? planIdForLog);
    const rawLockWait = await this.lockWaitCache.get(lockWaitKey, planIdForLog);
    const stashedLockWait = parseLockWaitState(rawLockWait);
    if (rawLockWait !== null && stashedLockWait === null) {
      await this.logger.warning(`Discarding malformed lock-wait state for job ${dispatchJob.id ?? ''}`, {
        jobId: planIdForLog,
      });
    }

    const handler = this.handlers.get(dispatchJob.name);
    if (handler === undefined) {
      await this.logger.error(`No handler registered for job type: ${dispatchJob.name}`, {
        jobId: planIdForLog,
      });
      throw new Error(`No handler registered for job type: ${dispatchJob.name}`);
    }

    try {
      const result = await handler(dispatchJob, jobToken);
      await this.cleanupLockWait(lockWaitKey, rawLockWait, planIdForLog);
      await this.clearHandoffDefer(dispatchJob, planIdForLog);
      return result;
    } catch (error) {
      if (error instanceof CrossBridgeHandoff) {
        throw error;
      }
      if (error instanceof DeviceLockUnavailable) {
        await this.handleLockContention(
          dispatchJob,
          jobToken,
          error,
          stashedLockWait,
          lockWaitKey,
          planIdForLog,
          createdAtMs,
          isBridgeLocal,
        );
      }
      if (isCrossBridgeError(error)) {
        const reason = getErrorMessage(error);
        await this.cleanupLockWait(lockWaitKey, rawLockWait, planIdForLog);
        await this.enforceHandoffDeadline(dispatchJob, planIdForLog);
        await this.rescheduleDelayed(
          dispatchJob,
          jobToken,
          Math.trunc(AGENT_HANDOFF_REDELAY_SECONDS * 1_000),
          `cross-bridge handoff: ${reason}`,
          createdAtMs,
          isBridgeLocal,
        );
        throw new CrossBridgeHandoff(`cross-bridge handoff: ${reason}`);
      }
      if (error instanceof LockLost) {
        const reason = getErrorMessage(error);
        await this.logger.warning(
          `Saga '${String(dispatchJob.data.saga_name ?? 'unknown')}' aborted for plan ${planIdForLog}: ${reason}`,
          { jobId: planIdForLog },
        );
        await this.cleanupLockWait(lockWaitKey, rawLockWait, planIdForLog);
        await this.rescheduleDelayed(
          dispatchJob,
          jobToken,
          Math.trunc(this.config.lockLostRedelaySeconds * 1_000),
          `lock recovery: ${reason}`,
          createdAtMs,
          isBridgeLocal,
        );
        throw new CrossBridgeHandoff(`lock recovery: ${reason}`);
      }
      await this.logger.error(
        `Job handler failed: name=${dispatchJob.name} id=${dispatchJob.id ?? ''}: ${getErrorMessage(error)}`,
        { jobId: planIdForLog },
      );
      throw error;
    }
  }

  private async handleLockContention(
    job: ProcessableJob<Record<string, unknown>>,
    jobToken: string,
    error: DeviceLockUnavailable,
    stashedLockWait: LockWaitState | null,
    lockWaitKey: string,
    planId: string,
    createdAtMs: number,
    isBridgeLocal: boolean,
  ): Promise<never> {
    const now = Date.now() / 1_000;
    const currentLockWait = stashedLockWait?.lock_key === error.lockKey ? stashedLockWait : null;
    let lockWait = recordLockContention(currentLockWait, error.lockKey, now, error.holderInfo);
    const elapsed = lockWaitElapsedSeconds(lockWait, now);
    const ttl = calculateLockWaitTtlSeconds(this.config.lockWaitHardCapSeconds);

    if (isLockWaitHardCapExceeded(lockWait, now, this.config.lockWaitHardCapSeconds)) {
      const hardCapError = `Lock wait exceeded hard cap (${this.config.lockWaitHardCapSeconds}s) on ${error.lockKey}`;
      await this.persistLockWait(lockWaitKey, lockWait, ttl, planId);
      await this.logger.error(
        `Lock wait hard cap exceeded on ${error.lockKey}: ${elapsed.toFixed(0)}s elapsed, ` +
          `${lockWait.attempts} attempts, holder=${lockWait.holder_plan_id ?? '?'} ` +
          `(${lockWait.holder_saga_name ?? '?'})`,
        { jobId: planId },
      );
      await this.planManager.failPlan(planId, hardCapError);
      await this.notifySafely(this.lockWaitEvent(job, JobStatus.FAILED, lockWait, hardCapError), planId);
      await this.notifySafely(this.planEvent(job, hardCapError), planId);
      throw new DeviceLockWaitExceeded(error.lockKey, elapsed, lockWait.attempts);
    }

    if (elapsed >= this.config.lockWaitWarningSeconds) {
      await this.logger.warning(
        `Lock contention on ${error.lockKey}: ${elapsed.toFixed(0)}s elapsed, ${lockWait.attempts} attempts, ` +
          `holder=${lockWait.holder_plan_id ?? '?'} (${lockWait.holder_saga_name ?? '?'})`,
        { jobId: planId },
      );
      if (shouldNotifyLockWait(lockWait, now, this.config.lockWaitWarningSeconds)) {
        await this.notifySafely(this.lockWaitEvent(job, JobStatus.BLOCKED, lockWait), planId);
        lockWait = markLockWaitNotified(lockWait, now);
      }
    }

    await this.persistLockWait(lockWaitKey, lockWait, ttl, planId);
    await this.rescheduleDelayed(
      job,
      jobToken,
      Math.trunc(AGENT_HANDOFF_REDELAY_SECONDS * 1_000),
      `lock contention: ${error.lockKey}`,
      createdAtMs,
      isBridgeLocal,
      lockWait,
    );
    throw new CrossBridgeHandoff(`lock contention: ${error.lockKey}`);
  }

  private async persistLockWait(key: string, lockWait: LockWaitState, ttl: number, planId: string): Promise<void> {
    await this.lockWaitCache.set(key, serializeLockWaitState(lockWait), ttl, planId);
  }

  private async cleanupLockWait(key: string, rawLockWait: string | null, planId: string): Promise<void> {
    if (rawLockWait !== null) {
      await this.lockWaitCache.delete(key, planId);
    }
  }

  private lockWaitEvent(
    job: ProcessableJob<Record<string, unknown>>,
    status: JobStatus,
    lockWait: LockWaitState,
    error: string | null = null,
  ): StepTransitionEvent {
    return {
      planId: String(job.data.plan_id ?? ''),
      stepName: LOCK_WAIT_STEP_NAME,
      status,
      deviceId: this.deviceIdFromJob(job),
      error,
      result: { lock_wait: lockWait },
      metadata: this.metadataFromJob(job),
    };
  }

  private planEvent(job: ProcessableJob<Record<string, unknown>>, error: string): StepTransitionEvent {
    return {
      planId: String(job.data.plan_id ?? ''),
      stepName: '__plan__',
      status: JobStatus.FAILED,
      deviceId: this.deviceIdFromJob(job),
      error,
      metadata: this.metadataFromJob(job),
    };
  }

  private deviceIdFromJob(job: ProcessableJob<Record<string, unknown>>): unknown {
    return isRecord(job.data.payload) ? (job.data.payload.device_id ?? '') : '';
  }

  private metadataFromJob(job: ProcessableJob<Record<string, unknown>>): Record<string, unknown> {
    const metadata = isRecord(job.data.metadata) ? { ...job.data.metadata } : {};
    if (!('saga_name' in metadata) && job.data.saga_name !== undefined) {
      metadata.saga_name = job.data.saga_name;
    }
    return metadata;
  }

  private async notifySafely(event: StepTransitionEvent, planId: string): Promise<void> {
    try {
      await this.notifications.notifyStepTransition(event);
    } catch (error) {
      await this.logger.warning(
        `Notification failed for plan ${planId} step ${event.stepName}: ${getErrorMessage(error)}`,
        { jobId: planId },
      );
    }
  }

  private handoffDeferJobKey(job: ProcessableJob<Record<string, unknown>>, planId: string): string {
    return job.id ?? planId;
  }

  // Bound the "agent not connected" reschedule loop. The sealed-envelope freshness window
  // (rescheduleDelayed) only fails hub-sealed jobs; locally-enqueued collection.run jobs
  // behind an enrich are plaintext and re-stamp createdAt each attempt, so they would defer
  // forever when the device never boots brokkr-live. Track cumulative deferral in Redis and
  // fail the job with a clear verdict once past HANDOFF_ABANDON_DEADLINE_SECONDS — the normal
  // short-lived handoff (agent boots within a couple of minutes) never reaches the deadline.
  private async enforceHandoffDeadline(job: ProcessableJob<Record<string, unknown>>, planId: string): Promise<void> {
    const key = handoffDeferRedisKey(this.handoffDeferJobKey(job, planId));
    const now = Date.now() / 1_000;
    const existing = parseHandoffDeferState(await this.lockWaitCache.get(key, planId));
    const state: HandoffDeferState = existing
      ? { first_deferred_at: existing.first_deferred_at, attempts: existing.attempts + 1 }
      : { first_deferred_at: now, attempts: 1 };
    const elapsed = now - state.first_deferred_at;

    if (elapsed >= HANDOFF_ABANDON_DEADLINE_SECONDS) {
      const verdict = 'discovery agent never connected — device did not boot brokkr-live';
      await this.logger.error(
        `Abandoning ${job.name} for plan ${planId} after ${elapsed.toFixed(0)}s / ${state.attempts} deferrals: ${verdict}`,
        { jobId: planId },
      );
      await this.lockWaitCache.delete(key, planId);
      await this.planManager.failPlan(planId, verdict);
      await this.notifySafely(this.planEvent(job, verdict), planId);
      throw new HandoffAbandoned(elapsed, state.attempts);
    }

    await this.lockWaitCache.set(key, JSON.stringify(state), HANDOFF_DEFER_REDIS_TTL_SECONDS, planId);
  }

  private async clearHandoffDefer(job: ProcessableJob<Record<string, unknown>>, planId: string): Promise<void> {
    const key = handoffDeferRedisKey(this.handoffDeferJobKey(job, planId));
    await this.lockWaitCache.delete(key, planId);
  }

  private async rescheduleDelayed(
    job: ProcessableJob<Record<string, unknown>>,
    jobToken: string,
    delayMs: number,
    reason: string,
    createdAtMs: number,
    isBridgeLocal: boolean,
    lockWait?: LockWaitState,
  ): Promise<void> {
    const timestamp = Date.now();
    if (timestamp + delayMs >= createdAtMs + FRESHNESS_WINDOW_MS) {
      const planId = String(job.data.plan_id ?? '');
      const terminalError = `Envelope freshness budget exhausted before ${reason}`;
      await this.logger.error(terminalError, { jobId: planId });
      await this.planManager.failPlan(planId, terminalError);
      if (lockWait !== undefined) {
        await this.notifySafely(this.lockWaitEvent(job, JobStatus.FAILED, lockWait, terminalError), planId);
      }
      await this.notifySafely(this.planEvent(job, terminalError), planId);
      throw new EnvelopeDeferralBudgetExceeded(terminalError);
    }

    const zone = isBridgeLocal ? this.zoneCrypto?.get() : null;
    const fieldsToUpdate = zone ? this.resealBridgeLocalJob(job, zone.zonePriv) : isBridgeLocal ? {} : undefined;

    await job.scripts.moveToDelayed(job.id, timestamp, delayMs, jobToken, {
      fieldsToUpdate,
      fetchNext: false,
      workerOpts: job.queue.opts,
      skipAttempt: true,
    });
    void this.logger.info(
      `BullMQ job ${job.id ?? ''} (${job.name}) rescheduled to delayed (+${delayMs.toFixed(0)}ms): ${reason}`,
    );
  }

  private resealBridgeLocalJob(
    job: ProcessableJob<Record<string, unknown>>,
    zonePriv: Buffer,
  ): Record<string, unknown> {
    const envelope = sealBridgeLocalJob(zonePriv, job.data, {
      job_id: job.id ?? '',
      job_name: job.name,
      queue_name: job.queue.name,
    });
    return { data: JSON.stringify(envelope) };
  }

  protected async logProcessingJob(name: string, id: string | null, planId: string): Promise<void> {
    await this.logger.info(`Processing job: name=${name} id=${id ?? ''}`, { jobId: planId });
  }
}

export { JOB_NAME };
