import { Injectable, Optional } from '@nestjs/common';
import { z } from 'zod';

import { getErrorMessage } from '../common/error-utils';

import { isRecord } from '@repo/utils';

import { AgentNotConnected, AgentNotResponsive } from '../agent/dispatch/grpc.exceptions';
import { ContextLogger } from '../logger/logger.service';
import {
  AGENT_WAIT_STEP_NAME,
  LOCK_WAIT_STEP_NAME,
  type StepTransitionEvent,
} from '../saga-framework/notifications.service';
import { LockLost } from '../saga-framework/saga-runner.service';
import { JobStatus } from '../saga-framework/state.types';
import { ZoneCryptoService } from '../zone-crypto/zone-crypto.service';

import { sealBridgeLocalJob } from './bridge-local-sig';
import {
  AGENT_HANDOFF_REDELAY_SECONDS,
  AgentWaitExceeded,
  DeviceLockWaitExceeded,
  EnvelopeDeferralBudgetExceeded,
  HANDOFF_DEFER_REDIS_KEY_PREFIX,
  HANDOFF_REDELAY_ESCALATION,
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

const handoffDeferStateSchema = z.object({
  first_deferred_at: z.number().finite().nonnegative(),
  attempts: z.number().int().nonnegative(),
});

type HandoffDeferState = z.infer<typeof handoffDeferStateSchema>;

function handoffDeferRedisKey(jobKey: string): string {
  return `${HANDOFF_DEFER_REDIS_KEY_PREFIX}:${jobKey}`;
}

function parseHandoffDeferState(raw: string | null): HandoffDeferState | null {
  if (raw === null) return null;
  try {
    const result = handoffDeferStateSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
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
  agentWaitHardCapSeconds: number;
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
  agentWaitHardCapSeconds: 0,
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
        await this.clearHandoffDefer(dispatchJob, planIdForLog);
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
        const handoffDelayMs = await this.enforceHandoffDeadline(dispatchJob, planIdForLog, reason);
        await this.rescheduleDelayed(
          dispatchJob,
          jobToken,
          handoffDelayMs,
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
        await this.clearHandoffDefer(dispatchJob, planIdForLog);
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
      await this.failPlanTerminally(
        job,
        planId,
        hardCapError,
        this.lockWaitEvent(job, JobStatus.FAILED, lockWait, hardCapError),
      );
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
    return isRecord(job.data.payload) ? (job.data.payload.device_id ?? '') : (job.data.device_id ?? '');
  }

  private async failPlanTerminally(
    job: ProcessableJob<Record<string, unknown>>,
    planId: string,
    error: string,
    stepEvent: StepTransitionEvent,
  ): Promise<void> {
    await this.planManager.failPlan(planId, error);
    await this.notifySafely(stepEvent, planId);
    await this.notifySafely(this.planEvent(job, error), planId);
  }

  private agentWaitEvent(
    job: ProcessableJob<Record<string, unknown>>,
    state: HandoffDeferState,
    error: string,
  ): StepTransitionEvent {
    return {
      planId: String(job.data.plan_id ?? ''),
      stepName: AGENT_WAIT_STEP_NAME,
      status: JobStatus.FAILED,
      deviceId: this.deviceIdFromJob(job),
      error,
      result: { agent_wait: state },
      metadata: this.metadataFromJob(job),
    };
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

  private async enforceHandoffDeadline(
    job: ProcessableJob<Record<string, unknown>>,
    planId: string,
    reason: string,
  ): Promise<number> {
    const key = handoffDeferRedisKey(this.handoffDeferJobKey(job, planId));
    const now = Date.now() / 1_000;
    const raw = await this.lockWaitCache.get(key, planId);
    const existing = parseHandoffDeferState(raw);
    if (raw !== null && existing === null) {
      await this.logger.warning(`Discarding malformed handoff-defer state for job ${job.id ?? ''}`, {
        jobId: planId,
      });
    }
    const state: HandoffDeferState = existing
      ? { first_deferred_at: existing.first_deferred_at, attempts: existing.attempts + 1 }
      : { first_deferred_at: now, attempts: 1 };
    const elapsed = now - state.first_deferred_at;
    const cap = this.config.agentWaitHardCapSeconds;
    const ttl = calculateLockWaitTtlSeconds(cap);
    await this.lockWaitCache.set(key, JSON.stringify(state), ttl, planId);

    if (cap > 0 && elapsed > cap) {
      const hardCapError = `Agent wait exceeded hard cap (${cap}s): ${reason}`;
      await this.logger.error(
        `Agent wait hard cap exceeded for job ${job.id ?? ''}: ${elapsed.toFixed(0)}s elapsed, ` +
          `${state.attempts} handoff attempts`,
        { jobId: planId },
      );
      await this.failPlanTerminally(job, planId, hardCapError, this.agentWaitEvent(job, state, hardCapError));
      throw new AgentWaitExceeded(String(this.deviceIdFromJob(job)), elapsed, state.attempts);
    }

    const tier = HANDOFF_REDELAY_ESCALATION.find((entry) => elapsed < entry.maxElapsedSeconds);
    return Math.trunc((tier?.delaySeconds ?? AGENT_HANDOFF_REDELAY_SECONDS) * 1_000);
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
