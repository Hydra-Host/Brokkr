import { z } from 'zod';

import {
  LOCK_WAIT_NOTIFY_INTERVALS_SECONDS,
  LOCK_WAIT_REDIS_KEY_PREFIX,
  LOCK_WAIT_REDIS_TTL_BUFFER_SECONDS,
  LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS,
} from './bullmq.types';

export const lockWaitStateSchema = z.object({
  run_id: z.string().min(1).optional(),
  first_deferred_at: z.number().finite().nonnegative(),
  first_blocked_at: z.number().finite().nonnegative().optional(),
  attempts: z.number().int().nonnegative(),
  reason: z.enum(['lock_contention', 'agent_unavailable', 'lock_lost']),
  lock_key: z.string().min(1).optional(),
  last_notified_at: z.number().finite().nonnegative(),
  holder_plan_id: z.string().optional(),
  holder_saga_name: z.string().optional(),
  holder_since: z.string().optional(),
});

const legacyLockWaitStateSchema = z.object({
  first_blocked_at: z.number().finite().nonnegative(),
  attempts: z.number().int().nonnegative(),
  lock_key: z.string().min(1),
  last_notified_at: z.number().finite().nonnegative(),
  holder_plan_id: z.string().optional(),
  holder_saga_name: z.string().optional(),
  holder_since: z.string().optional(),
});

const lockHolderInfoSchema = z.object({
  plan_id: z.string().optional(),
  saga_name: z.string().optional(),
  acquired_at: z.string().optional(),
});

const timestampSchema = z.number().finite().nonnegative();
const secondsSchema = z.number().int().nonnegative();

export type LockWaitState = z.infer<typeof lockWaitStateSchema>;
export type DeferredReason = LockWaitState['reason'];

export function lockWaitRedisKey(jobId: string): string {
  return `${LOCK_WAIT_REDIS_KEY_PREFIX}:${jobId}`;
}

export function parseLockWaitState(raw: string | null): LockWaitState | null {
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    const result = lockWaitStateSchema.safeParse(parsed);
    if (result.success) return result.data;

    const legacy = legacyLockWaitStateSchema.safeParse(parsed);
    if (!legacy.success) return null;
    return lockWaitStateSchema.parse({
      ...legacy.data,
      first_deferred_at: legacy.data.first_blocked_at,
      reason: 'lock_contention',
    });
  } catch {
    return null;
  }
}

export function serializeLockWaitState(state: LockWaitState): string {
  return JSON.stringify(lockWaitStateSchema.parse(state));
}

export function recordLockContention(
  existing: LockWaitState | null,
  lockKey: string,
  nowSeconds: number,
  holderInfo?: unknown,
  runId?: string,
): LockWaitState {
  const now = timestampSchema.parse(nowSeconds);
  const current: LockWaitState =
    existing === null
      ? {
          first_deferred_at: now,
          ...(runId === undefined ? {} : { run_id: runId }),
          attempts: 0,
          reason: 'lock_contention',
          last_notified_at: 0,
        }
      : lockWaitStateSchema.parse(existing);
  const sameLock = current.lock_key === lockKey;
  const stateRunId = runId ?? current.run_id;

  const {
    holder_plan_id: _holderPlanId,
    holder_saga_name: _holderSagaName,
    holder_since: _holderSince,
    ...withoutHolder
  } = current;
  const next: LockWaitState = {
    ...withoutHolder,
    ...(stateRunId === undefined ? {} : { run_id: stateRunId }),
    first_blocked_at: sameLock ? (current.first_blocked_at ?? now) : now,
    attempts: sameLock ? current.attempts + 1 : 1,
    reason: 'lock_contention',
    lock_key: lockKey,
  };
  const holder = lockHolderInfoSchema.safeParse(holderInfo);
  if (holder.success) {
    if (holder.data.plan_id !== undefined) next.holder_plan_id = holder.data.plan_id;
    if (holder.data.saga_name !== undefined) next.holder_saga_name = holder.data.saga_name;
    if (holder.data.acquired_at !== undefined) next.holder_since = holder.data.acquired_at;
  }

  return lockWaitStateSchema.parse(next);
}

export function recordDeferredState(
  existing: LockWaitState | null,
  reason: Exclude<DeferredReason, 'lock_contention'>,
  nowSeconds: number,
  runId?: string,
): LockWaitState {
  const now = timestampSchema.parse(nowSeconds);
  const current = existing === null ? null : lockWaitStateSchema.parse(existing);
  const stateRunId = runId ?? current?.run_id;
  return lockWaitStateSchema.parse({
    ...(stateRunId === undefined ? {} : { run_id: stateRunId }),
    first_deferred_at: current?.first_deferred_at ?? now,
    first_blocked_at: current?.first_blocked_at,
    attempts: (current?.attempts ?? 0) + 1,
    reason,
    lock_key: current?.lock_key,
    last_notified_at: current?.last_notified_at ?? 0,
    holder_plan_id: current?.holder_plan_id,
    holder_saga_name: current?.holder_saga_name,
    holder_since: current?.holder_since,
  });
}

export function deferredElapsedSeconds(state: LockWaitState, nowSeconds: number): number {
  const parsed = lockWaitStateSchema.parse(state);
  const now = timestampSchema.parse(nowSeconds);
  return Math.max(0, now - parsed.first_deferred_at);
}

export function lockWaitElapsedSeconds(state: LockWaitState, nowSeconds: number): number {
  const parsed = lockWaitStateSchema.parse(state);
  const now = timestampSchema.parse(nowSeconds);
  return Math.max(0, now - (parsed.first_blocked_at ?? parsed.first_deferred_at));
}

export function calculateLockWaitTtlSeconds(hardCapSeconds: number): number {
  const hardCap = secondsSchema.parse(hardCapSeconds);
  return Math.max(LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS, hardCap + LOCK_WAIT_REDIS_TTL_BUFFER_SECONDS);
}

export function selectLockWaitNotificationIntervalSeconds(elapsedSeconds: number): number | null {
  const elapsed = timestampSchema.parse(elapsedSeconds);
  for (let index = LOCK_WAIT_NOTIFY_INTERVALS_SECONDS.length - 1; index >= 0; index -= 1) {
    const interval = LOCK_WAIT_NOTIFY_INTERVALS_SECONDS[index];
    if (elapsed >= interval) return interval;
  }
  return null;
}

export function shouldNotifyLockWait(state: LockWaitState, nowSeconds: number, warningSeconds: number): boolean {
  const parsed = lockWaitStateSchema.parse(state);
  const now = timestampSchema.parse(nowSeconds);
  const warning = secondsSchema.parse(warningSeconds);
  const elapsed = deferredElapsedSeconds(parsed, now);
  if (elapsed < warning) return false;

  const lastElapsed = parsed.last_notified_at === 0 ? elapsed : deferredElapsedSeconds(parsed, parsed.last_notified_at);
  const interval = selectLockWaitNotificationIntervalSeconds(lastElapsed);
  return interval !== null && now - parsed.last_notified_at >= interval;
}

export function markLockWaitNotified(state: LockWaitState, nowSeconds: number): LockWaitState {
  return lockWaitStateSchema.parse({
    ...lockWaitStateSchema.parse(state),
    last_notified_at: timestampSchema.parse(nowSeconds),
  });
}

export function isLockWaitHardCapExceeded(state: LockWaitState, nowSeconds: number, hardCapSeconds: number): boolean {
  const hardCap = secondsSchema.parse(hardCapSeconds);
  return hardCap > 0 && lockWaitElapsedSeconds(state, nowSeconds) > hardCap;
}
