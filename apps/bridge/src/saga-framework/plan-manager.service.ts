import { Injectable, Logger } from '@nestjs/common';
import { isRecord } from '@repo/utils';
import { getErrorMessage } from '../common/error-utils';

import type { RedisEncryptor } from '../common/redis/redis-client/redis-encryptor';
import { SagaLoggerLike } from './notifications.service';
import type { LifecyclePlan, LifecyclePlanStep, LifecyclePlanStepResult } from './plan.types';
import type { SagaDef } from './saga.types';
import { coerceStatus, transitionTimestamps } from './state.service';
import { JobStatus, TERMINAL_STATUSES } from './state.types';

export interface RedisLike {
  get(key: string): Promise<string | Buffer | null>;
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  scan(pattern: string): Promise<string[]>;
}

export interface ResumablePlan {
  planId: string;
  sagaName: string;
  payload: Record<string, unknown>;
  deviceId: string | number;
  jobId?: string;
}

function defaultLogger(name: string): SagaLoggerLike {
  const nest = new Logger(name);
  return {
    info: (message: string) => nest.log(message),
    warn: (message: string) => nest.warn(message),
    error: (message: string) => nest.error(message),
  };
}

const PLAN_TTL_OVERRIDES: Record<string, number> = {
  device_health_check: 60,
  inventory_collection: 3300,
};

const ENCRYPTED_PAYLOAD_KEY = '_enc_original_payload';
let warnedMissingEncryptor = false;

function nowSec(): number {
  return Date.now() / 1000;
}

export function planStatusFromSteps(steps: LifecyclePlanStep[]): JobStatus {
  if (steps.some((s) => s.status === JobStatus.FAILED)) return JobStatus.FAILED;
  if (steps.some((s) => s.status === JobStatus.CANCELLED)) return JobStatus.CANCELLED;
  if (steps.length > 0 && steps.every((s) => s.status === JobStatus.COMPLETED)) {
    return JobStatus.COMPLETED;
  }
  if (steps.some((s) => s.status === JobStatus.RUNNING)) return JobStatus.RUNNING;
  return JobStatus.PENDING;
}

export function transitionPlanStep(
  plan: LifecyclePlan,
  args: {
    stepName: string;
    status: unknown;
    error?: string | null;
    result?: LifecyclePlanStepResult | null;
    queueName?: string | null;
    jobId?: string | null;
    now?: number;
  },
): LifecyclePlan {
  const nextStatus = coerceStatus(args.status);
  const now = args.now ?? nowSec();

  const nextSteps: LifecyclePlanStep[] = [];
  let matched = false;
  for (const step of plan.steps) {
    if (step.step_name !== args.stepName) {
      nextSteps.push(step);
      continue;
    }
    matched = true;
    const { startedAt, completedAt } = transitionTimestamps({
      status: nextStatus,
      startedAt: step.started_at,
      completedAt: step.completed_at,
      now,
    });
    nextSteps.push({
      ...step,
      status: nextStatus,
      started_at: startedAt,
      completed_at: completedAt,
      error: args.error !== undefined && args.error !== null ? args.error : step.error,
      result: args.result !== undefined && args.result !== null ? args.result : step.result,
      queue_name: args.queueName !== undefined && args.queueName !== null ? args.queueName : step.queue_name,
      job_id: args.jobId !== undefined && args.jobId !== null ? args.jobId : step.job_id,
    });
  }

  if (!matched) return plan;

  const planStatus = planStatusFromSteps(nextSteps);
  const planTimestamps = transitionTimestamps({
    status: planStatus,
    startedAt: plan.started_at,
    completedAt: plan.completed_at,
    now,
  });
  let completedAt = planTimestamps.completedAt;
  if (!TERMINAL_STATUSES.has(planStatus)) {
    completedAt = null;
  }

  let planError = plan.error;
  if (planStatus === JobStatus.FAILED || planStatus === JobStatus.CANCELLED) {
    if (args.error !== undefined && args.error !== null) {
      planError = args.error;
    } else {
      const firstErr = nextSteps.find(
        (s) => (s.status === JobStatus.FAILED || s.status === JobStatus.CANCELLED) && Boolean(s.error),
      );
      planError = firstErr ? firstErr.error : plan.error;
    }
  } else if (planStatus === JobStatus.COMPLETED) {
    planError = null;
  }

  return {
    ...plan,
    status: planStatus,
    started_at: planTimestamps.startedAt,
    completed_at: completedAt,
    error: planError,
    steps: nextSteps,
  };
}

export function rewindStepsFrom(plan: LifecyclePlan, args: { rewindTo: string; failedStep: string }): LifecyclePlan {
  const rewindIndex = plan.steps.findIndex((s) => s.step_name === args.rewindTo);
  if (rewindIndex === -1) {
    return plan;
  }

  const nextSteps: LifecyclePlanStep[] = plan.steps.map((step, i) => {
    if (i < rewindIndex) return step;
    if (step.step_name === args.failedStep) {
      return {
        ...step,
        status: JobStatus.PENDING,
        started_at: null,
        completed_at: null,
        error: null,
        result: null,
        attempt: step.attempt + 1,
      };
    }
    return {
      ...step,
      status: JobStatus.PENDING,
      started_at: null,
      completed_at: null,
      error: null,
      result: null,
    };
  });

  return {
    ...plan,
    status: JobStatus.RUNNING,
    completed_at: null,
    error: null,
    steps: nextSteps,
    metadata: mergePreservingOrder(plan.metadata, { rewound: true }),
  };
}

export function serializeLifecyclePlan(plan: LifecyclePlan): Record<string, unknown> {
  return {
    plan_id: plan.plan_id,
    device_id: plan.device_id,
    job_class: plan.job_class,
    status: plan.status,
    created_at: plan.created_at,
    started_at: plan.started_at,
    completed_at: plan.completed_at,
    error: plan.error,
    metadata: { ...plan.metadata },
    steps: plan.steps.map((step) => ({
      step_name: step.step_name,
      operation: step.operation,
      status: step.status,
      created_at: step.created_at,
      started_at: step.started_at,
      completed_at: step.completed_at,
      error: step.error,
      result: step.result,
      job_id: step.job_id,
      queue_name: step.queue_name,
      attempt: step.attempt,
    })),
  };
}

function mergePreservingOrder(
  base: Record<string, unknown>,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(base)) {
    out[k] = Object.prototype.hasOwnProperty.call(updates, k) ? updates[k] : v;
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = v;
  }
  return out;
}

function asNumber(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) throw new Error(`could not convert string to float: '${raw}'`);
    return parsed;
  }
  return fallback;
}

function asNullableNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function asNullableString(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  return String(raw);
}

function asResult(raw: unknown): LifecyclePlanStepResult {
  if (raw === undefined) return null;
  return raw;
}

function strictInt(raw: unknown, fallback: number): number {
  if (raw === null || raw === undefined || raw === 0 || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw ? 1 : 0;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new Error(`cannot convert non-finite number to integer: ${raw}`);
    return Math.trunc(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!/^[+-]?\d+$/.test(trimmed)) {
      throw new Error(`invalid integer: '${raw}'`);
    }
    return parseInt(trimmed, 10);
  }
  throw new Error(`expected string or number, got '${typeof raw}'`);
}

export function deserializeLifecyclePlan(data: Record<string, unknown>): LifecyclePlan {
  const now = nowSec();
  const rawSteps = Array.isArray(data.steps) ? data.steps : [];
  const steps: LifecyclePlanStep[] = rawSteps.map((raw) => {
    const r = (raw ?? {}) as Record<string, unknown>;
    return {
      step_name: String(r.step_name || ''),
      operation: String(r.operation || ''),
      status: coerceStatus(r.status),
      created_at: r.created_at ? asNumber(r.created_at, now) : now,
      started_at: asNullableNumber(r.started_at),
      completed_at: asNullableNumber(r.completed_at),
      error: asNullableString(r.error),
      result: asResult(r.result),
      job_id: asNullableString(r.job_id),
      queue_name: asNullableString(r.queue_name),
      attempt: strictInt(r.attempt, 0),
    };
  });

  return {
    plan_id: String(data.plan_id || ''),
    device_id: data.device_id ?? null,
    job_class: String(data.job_class || 'lifecycle'),
    status: coerceStatus(data.status),
    created_at: data.created_at ? asNumber(data.created_at, now) : now,
    started_at: asNullableNumber(data.started_at),
    completed_at: asNullableNumber(data.completed_at),
    error: asNullableString(data.error),
    metadata: (data.metadata as Record<string, unknown> | undefined)
      ? { ...(data.metadata as Record<string, unknown>) }
      : {},
    steps,
  };
}

export interface PlanManagerConfig {
  redisKeyPrefix: string;
  defaultJobTtlSeconds: number;
}

const PLAN_CACHE_MAX = 5000;

class BoundedPlanCache {
  private readonly entries = new Map<string, LifecyclePlan>();

  constructor(private readonly max: number) {}

  get(planId: string): LifecyclePlan | undefined {
    return this.entries.get(planId);
  }

  set(planId: string, plan: LifecyclePlan): void {
    this.entries.delete(planId);
    this.entries.set(planId, plan);
    if (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  delete(planId: string): boolean {
    return this.entries.delete(planId);
  }

  get size(): number {
    return this.entries.size;
  }
}

@Injectable()
export class PlanManagerService {
  private readonly plans = new BoundedPlanCache(PLAN_CACHE_MAX);
  private readonly logger: SagaLoggerLike;
  private readonly config: PlanManagerConfig;
  private readonly redis: RedisLike;

  constructor(
    config: PlanManagerConfig,
    redis: RedisLike,
    logger?: SagaLoggerLike,
    private readonly encryptor?: RedisEncryptor,
  ) {
    if (redis === null || redis === undefined) {
      throw new Error(
        'PlanManagerService requires a RedisLike client: without Redis, lifecycle plans live only in process memory and are lost on restart, breaking cross-process saga lookup and crash recovery',
      );
    }
    this.config = config;
    this.redis = redis;
    this.logger = logger ?? defaultLogger(PlanManagerService.name);
  }

  private redisKey(planId: string): string {
    return `${this.config.redisKeyPrefix}:plan:${planId}`;
  }

  async start(): Promise<void> {}

  private async persistPlan(plan: LifecyclePlan): Promise<void> {
    this.plans.set(plan.plan_id, plan);
    const ttl = PLAN_TTL_OVERRIDES[plan.job_class] ?? this.config.defaultJobTtlSeconds;
    const key = this.redisKey(plan.plan_id);
    try {
      const serialized = serializeLifecyclePlan(plan);
      const metadata = { ...plan.metadata };
      if (Object.prototype.hasOwnProperty.call(metadata, 'original_payload')) {
        if (this.encryptor !== undefined) {
          metadata[ENCRYPTED_PAYLOAD_KEY] = this.encryptor.encrypt(JSON.stringify(metadata.original_payload));
          delete metadata.original_payload;
        } else {
          this.warnMissingEncryptor();
        }
      }
      serialized.metadata = metadata;
      await this.redis.set(key, JSON.stringify(serialized), { ex: ttl });
    } catch (error) {
      this.logger.warn(
        `Failed to persist lifecycle plan ${plan.plan_id} to Redis: ${getErrorMessage(error)} (key=${key})`,
      );
    }
  }

  async getPlan(planId: string): Promise<LifecyclePlan | null> {
    const raw = await this.redis.get(this.redisKey(planId));
    if (raw) {
      try {
        const plan = this.deserializeFromRedis(raw);
        this.plans.set(plan.plan_id, plan);
        return plan;
      } catch (error) {
        this.logger.warn(`Failed to decode lifecycle plan ${planId} from Redis: ${getErrorMessage(error)}`);
      }
    }
    return this.plans.get(planId) ?? null;
  }

  async scanResumablePlans(args: {
    graceSecs: number;
    staleSecs: number;
    batchSize: number;
  }): Promise<ResumablePlan[]> {
    const keys = await this.redis.scan(`${this.config.redisKeyPrefix}:plan:*`);
    const now = nowSec();
    const results: ResumablePlan[] = [];
    for (const key of keys) {
      if (results.length >= args.batchSize) break;
      try {
        const raw = await this.redis.get(key);
        if (!raw) continue;
        const plan = this.deserializeFromRedis(raw);
        if (TERMINAL_STATUSES.has(plan.status)) continue;
        if (plan.created_at >= now - args.graceSecs) continue;
        if (!plan.steps.some((step) => step.status === JobStatus.PENDING || step.status === JobStatus.RUNNING))
          continue;
        if (
          plan.steps.some(
            (step) =>
              step.status === JobStatus.RUNNING && step.started_at !== null && step.started_at > now - args.staleSecs,
          )
        ) {
          continue;
        }
        const payload = plan.metadata.original_payload;
        if (!isRecord(payload)) continue;
        const jobId = plan.metadata.bullmq_job_id;
        results.push({
          planId: plan.plan_id,
          sagaName: String(plan.metadata.saga_name ?? plan.job_class),
          payload,
          deviceId:
            typeof plan.device_id === 'string' || typeof plan.device_id === 'number'
              ? plan.device_id
              : String(plan.device_id ?? ''),
          ...(typeof jobId === 'string' ? { jobId } : {}),
        });
      } catch (error) {
        this.logger.warn(`Failed to decode lifecycle plan at ${key}: ${getErrorMessage(error)}`);
      }
    }
    return results;
  }

  async backfillOriginalPayload(planId: string, payload: Record<string, unknown>): Promise<void> {
    const plan = await this.getPlan(planId);
    if (plan === null || Object.prototype.hasOwnProperty.call(plan.metadata, 'original_payload')) return;
    await this.persistPlan({
      ...plan,
      metadata: { ...plan.metadata, original_payload: payload },
    });
  }

  private deserializeFromRedis(raw: string | Buffer): LifecyclePlan {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) throw new TypeError('Lifecycle plan must be an object');
    const metadata = isRecord(parsed.metadata) ? { ...parsed.metadata } : {};
    const encryptedPayload = metadata[ENCRYPTED_PAYLOAD_KEY];
    if (typeof encryptedPayload === 'string') {
      if (this.encryptor !== undefined) {
        const payload: unknown = JSON.parse(this.encryptor.decrypt(encryptedPayload));
        metadata.original_payload = payload;
        delete metadata[ENCRYPTED_PAYLOAD_KEY];
      } else {
        this.warnMissingEncryptor();
      }
    }
    return deserializeLifecyclePlan({ ...parsed, metadata });
  }

  private warnMissingEncryptor(): void {
    if (warnedMissingEncryptor) return;
    warnedMissingEncryptor = true;
    this.logger.warn('Plan payload encryption is unavailable because no RedisEncryptor is configured');
  }

  async createPlanFromSaga(args: {
    planId: string;
    deviceId: unknown;
    jobClass: string;
    sagaDef: SagaDef;
    queueName?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<LifecyclePlan> {
    const now = nowSec();
    const steps: LifecyclePlanStep[] = args.sagaDef.steps.map((stepDef) => ({
      step_name: stepDef.name,
      operation: stepDef.operation ?? '',
      status: JobStatus.PENDING,
      created_at: now,
      started_at: null,
      completed_at: null,
      error: null,
      result: null,
      job_id: null,
      queue_name: args.queueName ?? null,
      attempt: 0,
    }));

    const plan: LifecyclePlan = {
      plan_id: args.planId,
      device_id: args.deviceId,
      job_class: args.jobClass,
      status: JobStatus.PENDING,
      created_at: now,
      started_at: null,
      completed_at: null,
      error: null,
      metadata: { ...(args.metadata ?? {}) },
      steps,
    };

    await this.persistPlan(plan);
    return plan;
  }

  async updateStepStatus(args: {
    planId: string;
    stepName: string;
    status: JobStatus;
    error?: string | null;
    result?: LifecyclePlanStepResult | null;
    queueName?: string | null;
    jobId?: string | null;
  }): Promise<void> {
    const current = await this.getPlan(args.planId);
    if (!current) return;

    const updated = transitionPlanStep(current, {
      stepName: args.stepName,
      status: args.status,
      error: args.error ?? null,
      result: args.result ?? null,
      queueName: args.queueName ?? null,
      jobId: args.jobId ?? null,
    });
    await this.persistPlan(updated);
  }

  async failPlan(planId: string, error: string): Promise<void> {
    const current = await this.getPlan(planId);
    if (!current) return;

    const now = nowSec();
    const steps = current.steps.map((step) => {
      if (TERMINAL_STATUSES.has(step.status)) return step;

      const { completedAt } = transitionTimestamps({
        status: JobStatus.CANCELLED,
        startedAt: step.started_at,
        completedAt: step.completed_at,
        now,
      });
      return {
        ...step,
        status: JobStatus.CANCELLED,
        completed_at: completedAt,
      };
    });
    await this.persistPlan({
      ...current,
      status: JobStatus.FAILED,
      error,
      completed_at: now,
      steps,
    });
  }

  async rewindPlan(args: { planId: string; rewindTo: string; failedStep: string }): Promise<LifecyclePlan | null> {
    const current = await this.getPlan(args.planId);
    if (!current) return null;

    if (!current.steps.some((step) => step.step_name === args.rewindTo)) {
      this.logger.error(
        `Cannot rewind plan ${args.planId}: rewindTo '${args.rewindTo}' (from failed step '${args.failedStep}') matches no plan step; rollback skipped`,
      );
    }

    const updated = rewindStepsFrom(current, {
      rewindTo: args.rewindTo,
      failedStep: args.failedStep,
    });
    await this.persistPlan(updated);
    return updated;
  }
}
