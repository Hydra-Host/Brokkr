import { Injectable } from '@nestjs/common';
import { getErrorMessage } from '../common/error-utils';

import { isRecord } from '@repo/utils';

import { coerceEnvelopeId, hasEnvelopeId } from '../saga-framework/dispatch-payload';
import type { SagaDef } from '../saga-framework/saga.types';

import { BridgeLocalPlanMissing, EPHEMERAL_SAGAS } from './bullmq.types';
import { DeviceLockUnavailable, type JobHandler, type ProcessableJob } from './handlers.service';
import { lockWaitRedisKey, parseLockWaitState } from './lock-wait';
import { redactPayloadForLog } from './redact';
import { resolveLockKey } from './saga-lock';
import { validateSagaPayload, type SagaPayloadSchemaRegistry } from './saga-payload-validate';

export interface SagaHandlerCache {
  acquireLock(
    lockKey: string,
    timeout: number,
    jobId?: string,
    holderInfo?: Record<string, string>,
  ): Promise<string | null>;
  releaseLock(lockKey: string, token: string, jobId?: string): Promise<boolean>;
  renewLockIfOwner(lockKey: string, expectedValue: string, ttl: number, jobId?: string): Promise<boolean>;
  readLockInfo?(lockKey: string, jobId?: string): Promise<Record<string, string> | null>;
  get?(key: string, jobId?: string): Promise<string | null>;
  delete?(key: string, jobId?: string): Promise<number>;
}

export interface SagaPlanManagerLike {
  start(): Promise<void>;
  getPlan(planId: string): Promise<unknown>;
  failPlan(planId: string, error: string): Promise<unknown>;
  createPlanFromSaga(args: {
    planId: string;
    deviceId: unknown;
    jobClass: string;
    sagaDef: SagaDef;
    queueName?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<unknown>;
  backfillOriginalPayload(planId: string, payload: Record<string, unknown>): Promise<void>;
}

export interface SagaRunnerLike {
  execute(
    saga: SagaDef,
    args: {
      planId: string;
      payload: Record<string, unknown>;
      lockLost?: {
        isSet(): boolean;
        wait(): Promise<void>;
        dispose?(): void;
      } | null;
    },
  ): Promise<{ status: string } | null>;
}

export interface SagaDefProvider {
  getSagaDef(sagaName: string): SagaDef | null;
}

export interface SagaCooldownClearer {
  clearCooldownAndEnqueue(deviceId: string, jobId: string): Promise<void>;
}

export interface SagaHandlerConfig {
  bullmqQueueName: string;
  deviceLockTimeoutSeconds: number;
  deviceLockRenewIntervalSeconds: number;
  lockWaitWarningSeconds?: number;
  lockWaitHardCapSeconds?: number;
}

export interface SagaHandlerLogger {
  debug(message: string, context?: { jobId?: string }): Promise<void>;
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

function requireKey(obj: Record<string, unknown>, key: string): unknown {
  if (!(key in obj)) {
    const err = new Error(`'${key}'`);
    err.name = 'RecordKeyError';
    throw err;
  }
  return obj[key];
}

class LockLostEvent {
  private fired = false;
  private resolveWait: (() => void) | null = null;
  private readonly waitPromise = new Promise<void>((resolve) => {
    this.resolveWait = resolve;
  });

  set(): void {
    if (this.fired) return;
    this.fired = true;
    this.resolveWait?.();
    this.resolveWait = null;
  }

  isSet(): boolean {
    return this.fired;
  }

  wait(): Promise<void> {
    return this.waitPromise;
  }

  dispose(): void {
    this.resolveWait = null;
  }
}

@Injectable()
export class SagaJobHandler {
  constructor(
    private readonly cache: SagaHandlerCache,
    private readonly planManager: SagaPlanManagerLike,
    private readonly runner: SagaRunnerLike,
    private readonly sagaProvider: SagaDefProvider,
    private readonly schemas: SagaPayloadSchemaRegistry,
    private readonly config: SagaHandlerConfig,
    private readonly cooldownClearer: SagaCooldownClearer,
    private readonly logger: SagaHandlerLogger,
  ) {}

  readonly handle: JobHandler = async (job) => this.run(job);

  private async run(job: ProcessableJob<Record<string, unknown>>): Promise<Record<string, string>> {
    const planIdRaw = requireKey(job.data, 'plan_id');
    const planId = String(planIdRaw);
    const sagaNameRaw = requireKey(job.data, 'saga_name');
    const sagaName = String(sagaNameRaw);
    const payloadRaw = requireKey(job.data, 'payload');
    if (!isRecord(payloadRaw)) {
      throw new TypeError(`Saga '${sagaName}' payload must be a JSON object`);
    }
    const payload = payloadRaw;
    const deviceId = coerceEnvelopeId(payload.device_id);

    validateSagaPayload(sagaName, payload, this.schemas);

    const redactedPayload = redactPayloadForLog(payload);
    await this.logger.debug(`Saga '${sagaName}' payload: ${JSON.stringify(redactedPayload)}`, { jobId: planId });

    const sagaDef = this.sagaProvider.getSagaDef(sagaName);
    if (sagaDef === null) {
      throw new Error(`Unknown saga workflow: ${sagaName}`);
    }

    await this.planManager.start();
    const existing = await this.planManager.getPlan(planId);
    const persistedPayload: Record<string, unknown> | undefined = EPHEMERAL_SAGAS.has(sagaName)
      ? undefined
      : JSON.parse(JSON.stringify(payload));
    if (existing == null) {
      if (job.isBridgeLocal === true) {
        await this.logger.error(
          `Bridge-local pickup for saga '${sagaName}' found no persisted plan ${planId} — failing closed instead of re-running device-mutating steps from scratch`,
          { jobId: planId },
        );
        throw new BridgeLocalPlanMissing(planId, sagaName);
      }
      const metadata: Record<string, unknown> = {
        saga_name: sagaName,
        ...(job.id === null ? {} : { bullmq_job_id: job.id }),
        ...(persistedPayload === undefined ? {} : { original_payload: persistedPayload }),
      };
      await this.planManager.createPlanFromSaga({
        planId,
        deviceId: hasEnvelopeId(deviceId) ? String(deviceId) : '',
        jobClass: sagaName,
        sagaDef,
        queueName: this.config.bullmqQueueName,
        metadata,
      });
      await this.logger.info(`Created plan for hub-enqueued saga '${sagaName}'`, { jobId: planId });
    } else if (persistedPayload !== undefined) {
      await this.planManager.backfillOriginalPayload(planId, persistedPayload);
    }

    const lockKey = resolveLockKey(sagaName, payload);
    const lockWaitKey = lockWaitRedisKey(job.id ?? planId);
    const storedLockWait = parseLockWaitState((await this.cache.get?.(lockWaitKey, planId)) ?? null);
    let lockWaitNeedsCleanup = storedLockWait !== null;
    let lockToken: string | null = null;
    const lockLostEvent = new LockLostEvent();
    let renewalStop: (() => void) | null = null;
    let sagaCompleted = false;

    try {
      if (lockKey !== null) {
        lockToken = await this.cache.acquireLock(lockKey, this.config.deviceLockTimeoutSeconds, planId, {
          plan_id: planId,
          saga_name: sagaName,
          acquired_at: String(Math.trunc(Date.now() / 1_000)),
        });
        if (lockToken === null) {
          const holderInfo = (await this.cache.readLockInfo?.(lockKey, planId)) ?? null;
          lockWaitNeedsCleanup = false;
          throw new DeviceLockUnavailable(lockKey, holderInfo);
        }
        renewalStop = this.startLockRenewal(lockKey, lockToken, planId, lockLostEvent);
        if (lockWaitNeedsCleanup) {
          await this.cache.delete?.(lockWaitKey, planId);
          lockWaitNeedsCleanup = false;
        }
      }

      const lockStatus = lockKey !== null ? `lock acquired: ${lockKey}` : 'no lock';
      await this.logger.info(`Starting saga '${sagaName}' for plan ${planId} (${lockStatus})`, { jobId: planId });

      const plan = await this.runner.execute(sagaDef, {
        planId,
        payload,
        lockLost: lockKey !== null ? lockLostEvent : null,
      });
      sagaCompleted = true;

      return { plan_id: planId, status: plan ? plan.status : 'unknown' };
    } finally {
      if (renewalStop !== null) renewalStop();
      try {
        if (lockKey !== null && lockToken !== null && (sagaCompleted || !lockLostEvent.isSet())) {
          let lockReleased: boolean | null = null;
          try {
            lockReleased = await this.cache.releaseLock(lockKey, lockToken, planId);
          } catch (error) {
            await this.logger.warning(`Failed to release lock ${lockKey}: ${getErrorMessage(error)}`, {
              jobId: planId,
            });
          }
          if (
            sagaCompleted &&
            hasEnvelopeId(deviceId) &&
            (lockReleased === true || (lockReleased === null && !lockLostEvent.isSet()))
          ) {
            await this.cooldownClearer.clearCooldownAndEnqueue(String(deviceId), planId);
          }
        }
      } finally {
        if (lockWaitNeedsCleanup) await this.cache.delete?.(lockWaitKey, planId);
      }
    }
  }

  private startLockRenewal(lockKey: string, token: string, planId: string, lockLostEvent: LockLostEvent): () => void {
    const intervalMs = this.config.deviceLockRenewIntervalSeconds * 1000;
    const leaseMs = this.config.deviceLockTimeoutSeconds * 1000;
    const deadlineSafetyMs = intervalMs / 2;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let deadlineTimer: NodeJS.Timeout | null = null;
    let leaseDeadline = performance.now() + leaseMs;
    let consecutiveErrors = 0;
    const signalLockLost = (): void => {
      if (stopped) return;
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
      lockLostEvent.set();
    };
    const armDeadline = (): void => {
      if (deadlineTimer !== null) clearTimeout(deadlineTimer);
      const delayMs = Math.max(0, leaseDeadline - performance.now() - deadlineSafetyMs);
      deadlineTimer = setTimeout(signalLockLost, delayMs);
    };
    const tick = async (): Promise<void> => {
      if (stopped) return;
      let renewed: boolean;
      try {
        renewed = await this.cache.renewLockIfOwner(lockKey, token, this.config.deviceLockTimeoutSeconds, planId);
      } catch (error) {
        consecutiveErrors += 1;
        if (consecutiveErrors < 2) {
          await this.logger.warning(`Lock renewal errored for ${lockKey} — retrying: ${getErrorMessage(error)}`, {
            jobId: planId,
          });
          if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
          return;
        }
        signalLockLost();
        await this.logger.warning(
          `Lock renewal errored twice for ${lockKey} — signaling saga to abort: ${getErrorMessage(error)}`,
          { jobId: planId },
        );
        return;
      }
      if (stopped) return;
      consecutiveErrors = 0;
      if (!renewed) {
        signalLockLost();
        await this.logger.warning(`Lock renewal failed for ${lockKey} — signaling saga to abort`, { jobId: planId });
        return;
      }
      if (stopped) return;
      leaseDeadline = performance.now() + leaseMs;
      armDeadline();
      timer = setTimeout(() => void tick(), intervalMs);
    };
    armDeadline();
    timer = setTimeout(() => void tick(), intervalMs);
    return () => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
        deadlineTimer = null;
      }
    };
  }
}
