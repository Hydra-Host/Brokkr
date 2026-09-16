import { z } from 'zod';

import { envInt, STRICT_INT_PATTERN } from '../common/env-utils';

import { FRESHNESS_WINDOW_MS } from '../zone-crypto/sealed-envelope.types';
import {
  LOCK_LOST_REDELAY_SECONDS,
  LOCK_RENEW_MAX_TRANSIENT_FAILURES,
  LOCK_RENEW_REDIS_COMMAND_ATTEMPTS,
  LOCK_RENEW_SAFETY_MARGIN_SECONDS,
  LOCK_WAIT_HARD_CAP_SECONDS,
  LOCK_WAIT_REDIS_TTL_BUFFER_SECONDS,
  LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS,
} from './bullmq.types';

export { LOCK_WAIT_REDIS_TTL_BUFFER_SECONDS, LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS } from './bullmq.types';

const STRICT_NUMBER_PATTERN = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;
const ENVELOPE_FRESHNESS_WINDOW_SECONDS = FRESHNESS_WINDOW_MS / 1_000;

const optionalEnvInt = z
  .string()
  .optional()
  .transform((value, ctx) => {
    if (value === undefined) return undefined;
    if (!STRICT_INT_PATTERN.test(value)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid integer: ${JSON.stringify(value)}` });
      return z.NEVER;
    }
    return Number.parseInt(value.replace(/_/g, ''), 10);
  })
  .pipe(z.number().int().optional());

const envNumber = (def: number) =>
  z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return def;
      if (!STRICT_NUMBER_PATTERN.test(value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `invalid number: ${JSON.stringify(value)}` });
        return z.NEVER;
      }
      return Number.parseFloat(value);
    })
    .pipe(z.number().finite());

const envSchema = z
  .object({
    BROKKR_ZONE_ID: z.string().optional(),
    JOB_REDIS_KEY_PREFIX: z.string().optional(),
    JOB_TTL_SECONDS: envInt(7_200),
    BULLMQ_QUEUE_NAME: z.string().optional(),
    BULLMQ_RETRIES: envInt(1),
    DELAYED_PROMOTE_INTERVAL_SECONDS: envInt(3),
    LIFECYCLE_WORKER_CONCURRENCY: envInt(10),
    DEVICE_LOCK_TIMEOUT_SECONDS: envInt(60),
    DEVICE_LOCK_RENEW_INTERVAL_SECONDS: envInt(20),
    REDIS_SOCKET_TIMEOUT: envNumber(5),
    LOCK_LOST_REDELAY_SECONDS: optionalEnvInt,
    LOCK_WAIT_WARNING_SECONDS: envInt(60),
    LOCK_WAIT_HARD_CAP_SECONDS: envInt(LOCK_WAIT_HARD_CAP_SECONDS),
    AGENT_WAIT_HARD_CAP_SECONDS: envInt(3_600),
    // MUST stay well below the 300s zone-crypto envelope freshness window (failover re-opens the same hub envelope after lock expiry) and above lockRenewTime so long sagas never stall.
    BULLMQ_LOCK_DURATION_MS: envInt(120_000),
    BULLMQ_LOCK_RENEW_TIME_MS: envInt(60_000),
    // Must stay >1: HA failover recovers a dead worker's saga via 'stalled'; BullMQ's default (1) fails the job instead of failing over.
    BULLMQ_MAX_STALLED_COUNT: envInt(5),
    BULLMQ_STALLED_INTERVAL_MS: envInt(30_000),
    BULLMQ_RESULTS_QUEUE_NAME: z.string().optional(),
    BULLMQ_RESULTS_PREFIX: z.string().optional(),
    BULLMQ_COLLECTION_QUEUE_NAME: z.string().optional(),
    COLLECTION_WORKER_CONCURRENCY: envInt(1),
    BROKKR_LIVE_INITIAL_DELAY_SECONDS: envInt(90),
    BROKKR_LIVE_WAIT_SECONDS: envInt(1800),
    STRANDED_PLAN_RESUME_INTERVAL_SECONDS: envInt(30),
    STRANDED_PLAN_GRACE_SECONDS: envInt(60),
    STRANDED_PLAN_RESUME_BATCH_SIZE: envInt(10),
    STRANDED_PLAN_RUNNING_STALE_SECONDS: envInt(1800),
  })
  .superRefine((env, ctx) => {
    const redisSocketTimeoutSeconds = env.REDIS_SOCKET_TIMEOUT;
    const lockLostRedelaySeconds =
      env.LOCK_LOST_REDELAY_SECONDS ?? Math.max(LOCK_LOST_REDELAY_SECONDS, env.DEVICE_LOCK_TIMEOUT_SECONDS + 30);
    if (env.DELAYED_PROMOTE_INTERVAL_SECONDS <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DELAYED_PROMOTE_INTERVAL_SECONDS must be positive',
      });
    }
    if (env.DEVICE_LOCK_TIMEOUT_SECONDS <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DEVICE_LOCK_TIMEOUT_SECONDS must be positive',
      });
    }
    if (env.DEVICE_LOCK_RENEW_INTERVAL_SECONDS <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DEVICE_LOCK_RENEW_INTERVAL_SECONDS must be positive',
      });
    }
    if (env.DEVICE_LOCK_RENEW_INTERVAL_SECONDS * 3 > env.DEVICE_LOCK_TIMEOUT_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'DEVICE_LOCK_RENEW_INTERVAL_SECONDS must be at most one third of DEVICE_LOCK_TIMEOUT_SECONDS',
      });
    }
    if (env.LOCK_WAIT_WARNING_SECONDS < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `LOCK_WAIT_WARNING_SECONDS (${env.LOCK_WAIT_WARNING_SECONDS}) must be non-negative`,
      });
    }
    if (env.LOCK_WAIT_HARD_CAP_SECONDS < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `LOCK_WAIT_HARD_CAP_SECONDS (${env.LOCK_WAIT_HARD_CAP_SECONDS}) must be non-negative`,
      });
    }
    if (env.AGENT_WAIT_HARD_CAP_SECONDS < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `AGENT_WAIT_HARD_CAP_SECONDS (${env.AGENT_WAIT_HARD_CAP_SECONDS}) must be non-negative`,
      });
    }
    const brokkrLiveBootWindowSeconds = env.BROKKR_LIVE_INITIAL_DELAY_SECONDS + env.BROKKR_LIVE_WAIT_SECONDS;
    if (env.AGENT_WAIT_HARD_CAP_SECONDS > 0 && env.AGENT_WAIT_HARD_CAP_SECONDS <= brokkrLiveBootWindowSeconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `AGENT_WAIT_HARD_CAP_SECONDS (${env.AGENT_WAIT_HARD_CAP_SECONDS}) must exceed the brokkr-live boot window ` +
          `(BROKKR_LIVE_INITIAL_DELAY_SECONDS + BROKKR_LIVE_WAIT_SECONDS = ${brokkrLiveBootWindowSeconds}) ` +
          'so slow-post hardware is not terminally failed while legitimately booting',
      });
    }
    if (env.LOCK_WAIT_HARD_CAP_SECONDS >= ENVELOPE_FRESHNESS_WINDOW_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `LOCK_WAIT_HARD_CAP_SECONDS (${env.LOCK_WAIT_HARD_CAP_SECONDS}) must be less than ` +
          `the envelope freshness window (${ENVELOPE_FRESHNESS_WINDOW_SECONDS})`,
      });
    }
    if (lockLostRedelaySeconds >= ENVELOPE_FRESHNESS_WINDOW_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `LOCK_LOST_REDELAY_SECONDS (${lockLostRedelaySeconds}) must be less than ` +
          `the envelope freshness window (${ENVELOPE_FRESHNESS_WINDOW_SECONDS})`,
      });
    }
    const renewalRetryDelaySeconds = env.DEVICE_LOCK_RENEW_INTERVAL_SECONDS / 2;
    const worstCaseRenewalSeconds =
      env.DEVICE_LOCK_RENEW_INTERVAL_SECONDS +
      redisSocketTimeoutSeconds * LOCK_RENEW_REDIS_COMMAND_ATTEMPTS * LOCK_RENEW_MAX_TRANSIENT_FAILURES +
      renewalRetryDelaySeconds * (LOCK_RENEW_MAX_TRANSIENT_FAILURES - 1) +
      LOCK_RENEW_SAFETY_MARGIN_SECONDS;
    if (redisSocketTimeoutSeconds <= 0 || worstCaseRenewalSeconds >= env.DEVICE_LOCK_TIMEOUT_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `DEVICE_LOCK_RENEW_INTERVAL_SECONDS (${env.DEVICE_LOCK_RENEW_INTERVAL_SECONDS}), ` +
          `REDIS_SOCKET_TIMEOUT (${redisSocketTimeoutSeconds}), and renewal retries leave no safety budget ` +
          `inside DEVICE_LOCK_TIMEOUT_SECONDS (${env.DEVICE_LOCK_TIMEOUT_SECONDS})`,
      });
    }
    if (lockLostRedelaySeconds <= env.DEVICE_LOCK_TIMEOUT_SECONDS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `LOCK_LOST_REDELAY_SECONDS (${lockLostRedelaySeconds}) must exceed ` +
          `DEVICE_LOCK_TIMEOUT_SECONDS (${env.DEVICE_LOCK_TIMEOUT_SECONDS})`,
      });
    }
  });

export interface BullmqConfig {
  // Zone-RELATIVE (e.g. `bridge:jobs`): RedisService.key() prepends the zone once; including it here doubles the key and the hub's sagaPlan scan never matches.
  redisKeyPrefix: string;
  defaultJobTtlSeconds: number;

  bullmqQueueName: string;
  bullmqPrefix: string;

  redisPrefix: string;

  queueMode: 'device';
  bullmqRetries: number;

  lifecycleWorkerConcurrency: number;
  deviceLockTimeoutSeconds: number;
  deviceLockRenewIntervalSeconds: number;
  lockLostRedelaySeconds?: number;
  lockWaitWarningSeconds?: number;
  lockWaitHardCapSeconds?: number;

  bullmqLockDurationMs: number;
  bullmqLockRenewTimeMs: number;
  bullmqMaxStalledCount: number;
  bullmqStalledIntervalMs: number;

  resultsQueueName: string;
  resultsQueuePrefix: string;

  collectionQueueName: string;
  collectionWorkerConcurrency: number;
  strandedPlanResumeIntervalSeconds: number;
  strandedPlanGraceSeconds: number;
  strandedPlanResumeBatchSize: number;
  strandedPlanRunningStaleSeconds: number;
}

export interface BullmqLockPolicyConfig {
  lockLostRedelaySeconds: number;
  lockWaitWarningSeconds: number;
  lockWaitHardCapSeconds: number;
  lockWaitRedisTtlSeconds: number;
  agentWaitHardCapSeconds: number;
}

export interface BullmqTimingConfig {
  delayedPromoteIntervalSeconds: number;
  brokkrLiveInitialDelaySeconds: number;
  brokkrLiveWaitSeconds: number;
}

export type ResolvedBullmqConfig = BullmqConfig & BullmqLockPolicyConfig & BullmqTimingConfig;

export function buildBullmqConfig(env: NodeJS.ProcessEnv = process.env): ResolvedBullmqConfig {
  const parsed = envSchema.parse(env);
  const lockLostRedelaySeconds =
    parsed.LOCK_LOST_REDELAY_SECONDS ?? Math.max(LOCK_LOST_REDELAY_SECONDS, parsed.DEVICE_LOCK_TIMEOUT_SECONDS + 30);

  // Zone prefix IS the zone UUID; must equal the hub's per-zone queue prefix.
  const redisPrefix = parsed.BROKKR_ZONE_ID?.trim() || '';
  const jobPrefix = (parsed.JOB_REDIS_KEY_PREFIX ?? 'bridge:jobs').trim();
  const redisKeyPrefix = jobPrefix;

  return {
    redisKeyPrefix,
    defaultJobTtlSeconds: parsed.JOB_TTL_SECONDS,
    bullmqQueueName: (parsed.BULLMQ_QUEUE_NAME ?? 'lifecycle').trim(),
    bullmqPrefix: redisPrefix || 'bull',
    redisPrefix,
    queueMode: 'device',
    bullmqRetries: parsed.BULLMQ_RETRIES,
    delayedPromoteIntervalSeconds: parsed.DELAYED_PROMOTE_INTERVAL_SECONDS,
    lifecycleWorkerConcurrency: parsed.LIFECYCLE_WORKER_CONCURRENCY,
    deviceLockTimeoutSeconds: parsed.DEVICE_LOCK_TIMEOUT_SECONDS,
    deviceLockRenewIntervalSeconds: parsed.DEVICE_LOCK_RENEW_INTERVAL_SECONDS,
    lockLostRedelaySeconds,
    lockWaitWarningSeconds: parsed.LOCK_WAIT_WARNING_SECONDS,
    lockWaitHardCapSeconds: parsed.LOCK_WAIT_HARD_CAP_SECONDS,
    lockWaitRedisTtlSeconds: Math.max(
      LOCK_WAIT_REDIS_TTL_DEFAULT_SECONDS,
      parsed.LOCK_WAIT_HARD_CAP_SECONDS + LOCK_WAIT_REDIS_TTL_BUFFER_SECONDS,
    ),
    agentWaitHardCapSeconds: parsed.AGENT_WAIT_HARD_CAP_SECONDS,
    bullmqLockDurationMs: parsed.BULLMQ_LOCK_DURATION_MS,
    bullmqLockRenewTimeMs: parsed.BULLMQ_LOCK_RENEW_TIME_MS,
    bullmqMaxStalledCount: parsed.BULLMQ_MAX_STALLED_COUNT,
    bullmqStalledIntervalMs: parsed.BULLMQ_STALLED_INTERVAL_MS,
    resultsQueueName: (parsed.BULLMQ_RESULTS_QUEUE_NAME ?? 'inbox').trim(),
    resultsQueuePrefix: (parsed.BULLMQ_RESULTS_PREFIX ?? 'results').trim(),
    collectionQueueName: (parsed.BULLMQ_COLLECTION_QUEUE_NAME ?? 'collection').trim(),
    collectionWorkerConcurrency: parsed.COLLECTION_WORKER_CONCURRENCY,
    brokkrLiveInitialDelaySeconds: parsed.BROKKR_LIVE_INITIAL_DELAY_SECONDS,
    brokkrLiveWaitSeconds: parsed.BROKKR_LIVE_WAIT_SECONDS,
    strandedPlanResumeIntervalSeconds: parsed.STRANDED_PLAN_RESUME_INTERVAL_SECONDS,
    strandedPlanGraceSeconds: parsed.STRANDED_PLAN_GRACE_SECONDS,
    strandedPlanResumeBatchSize: parsed.STRANDED_PLAN_RESUME_BATCH_SIZE,
    strandedPlanRunningStaleSeconds: parsed.STRANDED_PLAN_RUNNING_STALE_SECONDS,
  };
}

let cached: ResolvedBullmqConfig | null = null;

export function getBullmqConfig(): ResolvedBullmqConfig {
  if (cached === null) {
    cached = buildBullmqConfig();
  }
  return cached;
}

export function resetBullmqConfigForTests(): void {
  cached = null;
}
