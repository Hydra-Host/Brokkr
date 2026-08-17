/**
 * Spoke-HA helpers for the failover / restart-resume e2e tests.
 *
 * TypeScript port of `tests/e2e/spoke_ha.py`.
 *
 * The sim runs N spokes as HA replicas of a single zone (see the control
 * center's `services.service.ts`): each spoke `i` binds HTTP `8000+i` /
 * gRPC `9082+i` but shares the same `BRIDGE_ZONE_ID` (zone 0), the same Redis
 * prefix, and therefore the same BullMQ lifecycle queue. Every spoke runs its own
 * in-process `WorkerSupervisor`, so all spokes pull `saga.run` jobs off the one
 * shared queue.
 *
 * This is the substrate the two tests exercise:
 *
 * - **Failover** -- a `saga.run` job whose worker dies is redelivered to another
 *   live worker on the same queue via BullMQ's stalled-job mechanism (default
 *   `stalledInterval` ~30s, `maxStalledCount` ~1), and the per-device Redis lock
 *   (`lock:{zone}:device:{id}`, `DEVICE_LOCK_TIMEOUT_SECONDS` default 60s)
 *   auto-expires on crash so the re-picked job can re-acquire it.
 * - **Restart-resume** -- the saga's plan is persisted in Redis
 *   (`{zone}:plan:{plan_id}` via `PlanManager`). When the same `plan_id`
 *   runs again, `SagaRunner.execute` re-reads the plan, marks the step that was
 *   RUNNING as FAILED (crash recovery), rewinds, and resumes.
 *
 * Detection + control surface used here:
 *
 * - The control center on `:3002` (`GET /api/services`) is the roster authority
 *   (ids `spoke`, `spoke-1`, ...; `running` / `ready` / `pid`).
 * - `POST /api/services/control` `{id, action}` cleanly stops/restarts exactly
 *   one spoke.
 * - Each spoke's stdout is captured to `{LOCAL_BROKKR_LOGS}/{id}.log`; the spoke
 *   logs `Starting saga '<name>' for plan <plan_id> (lock acquired: device:<id>)`
 *   when a worker begins running a device's saga, so the log is the authoritative
 *   "which spoke is working this device" signal.
 */

import { Queue } from 'bullmq';
import Redis from 'ioredis';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { z } from 'zod';

import { pollUntil } from './helpers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const CONTROL_CENTER_URL = process.env.LOCAL_BROKKR_URL ?? 'http://127.0.0.1:3002';

/** Bridge zone ID -- mirrors `get_settings().bridge.zone_id`. */
const BRIDGE_ZONE_ID = process.env.BRIDGE_ZONE_ID ?? '';

// Mirror the bridge's job-key composition (apps/bridge/src/bullmq/bullmq.config.ts):
//   redisKeyPrefix = zone ? `${zone}:${jobPrefix}` : jobPrefix
// jobPrefix is configurable via JOB_REDIS_KEY_PREFIX (default 'bridge:jobs'); the
// zone segment appears exactly once, and is dropped entirely when unset (no leading colon).
const JOB_REDIS_KEY_PREFIX = (process.env.JOB_REDIS_KEY_PREFIX ?? 'bridge:jobs').trim();
const JOB_KEY_PREFIX = BRIDGE_ZONE_ID ? `${BRIDGE_ZONE_ID}:${JOB_REDIS_KEY_PREFIX}` : JOB_REDIS_KEY_PREFIX;

function bridgeRedisKey(key: string): string {
  return BRIDGE_ZONE_ID ? `${BRIDGE_ZONE_ID}:${key}` : key;
}

// ---------------------------------------------------------------------------
// Control center HTTP helpers (:3002)
// ---------------------------------------------------------------------------

interface SpokeInfo {
  id: string;
  running: boolean;
  ready: boolean;
  pid?: number;
  [key: string]: unknown;
}

async function ccGet<T = unknown>(urlPath: string, timeoutMs = 10_000): Promise<T> {
  const response = await fetch(`${CONTROL_CENTER_URL}${urlPath}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as T;
}

async function ccPost<T = unknown>(urlPath: string, body: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
  const response = await fetch(`${CONTROL_CENTER_URL}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Control center queries
// ---------------------------------------------------------------------------

/**
 * True if the control center API answers on :3002 (else the tests skip).
 */
export async function controlCenterReachable(): Promise<boolean> {
  try {
    await ccGet('/api/services', 5_000);
    return true;
  } catch {
    return false;
  }
}

/**
 * The spoke roster from the control center, each `{id, running, ready, pid, ...}`.
 *
 * Filters the full service list (which also includes hub instances) down to
 * the spoke ids (`spoke`, `spoke-1`, ...).
 */
export async function listSpokes(): Promise<SpokeInfo[]> {
  const services = await ccGet<unknown[]>('/api/services');
  if (!Array.isArray(services)) return [];
  return services.filter(
    (s): s is SpokeInfo => typeof s === 'object' && s !== null && String((s as SpokeInfo).id ?? '').startsWith('spoke'),
  );
}

/**
 * Spokes the control center reports as running AND ready (port bound).
 */
export async function runningSpokes(): Promise<SpokeInfo[]> {
  const spokes = await listSpokes();
  return spokes.filter((s) => s.running && s.ready);
}

/**
 * Issue start / stop / restart for one spoke via the control center.
 *
 * `stop` SIGTERMs the spoke's whole process group (escalating to SIGKILL
 * after ~4s); `restart` stops then relaunches it after a short gap.
 */
export async function controlSpoke(spokeId: string, action: 'start' | 'stop' | 'restart'): Promise<void> {
  await ccPost('/api/services/control', { id: spokeId, action });
}

/**
 * Block until the named spoke reaches the desired `running` state (or timeout).
 *
 * Returns the final observed state so the caller asserts on it.
 */
export async function awaitSpokeState(
  spokeId: string,
  opts: { running: boolean; timeout?: number; interval?: number },
): Promise<boolean> {
  const timeout = opts.timeout ?? 120_000;
  const interval = opts.interval ?? 3_000;

  const result = await pollUntil(
    async () => {
      const spokes = await listSpokes();
      const match = spokes.find((s) => s.id === spokeId);
      return Boolean(match && match.running);
    },
    (state) => state === opts.running,
    { timeout, interval },
  );
  return result;
}

// ---------------------------------------------------------------------------
// Spoke log inspection (which spoke is working a device)
// ---------------------------------------------------------------------------

/**
 * Where the control center writes per-service console logs.
 *
 * Mirrors `ServicesService`: `LOCAL_BROKKR_LOGS` or `{tmpdir}/brokkr-local/logs`.
 * The spoke logs land at `{dir}/{id}.log`.
 */
/**
 * Resolve a spoke's console log. The spoke runs as a process-compose process, so
 * its stdout is at `/tmp/devenv-<hash>/processes/logs/<id>.stdout.log` (newest
 * devenv dir wins -- stale ones may linger). `LOCAL_BROKKR_LOGS` (the legacy
 * `<id>.log` layout) is honored first when set.
 */
export function spokeLogPath(spokeId: string): string {
  const override = process.env.LOCAL_BROKKR_LOGS;
  if (override) {
    const legacy = path.join(override, `${spokeId}.log`);
    if (fs.existsSync(legacy)) return legacy;
  }
  let best: { p: string; mtime: number } | null = null;
  try {
    for (const d of fs.readdirSync('/tmp')) {
      if (!d.startsWith('devenv-')) continue;
      const p = path.join('/tmp', d, 'processes', 'logs', `${spokeId}.stdout.log`);
      try {
        const st = fs.statSync(p);
        if (!best || st.mtimeMs > best.mtime) best = { p, mtime: st.mtimeMs };
      } catch {
        /* not in this devenv dir */
      }
    }
  } catch {
    /* /tmp unreadable */
  }
  return best?.p ?? path.join(override ?? path.join(os.tmpdir(), 'brokkr-local', 'logs'), `${spokeId}.log`);
}

/**
 * True if the spoke's log mentions this plan id.
 *
 * Only the spoke that picks the job off the shared queue runs (and logs) the saga
 * for that plan, so a plan id appearing in a spoke's log identifies it as the
 * worker. The TS bridge logs `Starting saga '<name>' for plan <plan_id>` but does
 * NOT emit the Python port's `lock acquired: device:<id>` suffix -- so we correlate
 * by plan id (== the device-record `last_job_id`), not by device id.
 */
export type SpokeLogOffsets = Readonly<Record<string, number>>;

export async function captureSpokeLogOffsets(): Promise<SpokeLogOffsets> {
  const offsets: Record<string, number> = {};
  for (const spoke of await listSpokes()) {
    try {
      offsets[spoke.id] = fs.statSync(spokeLogPath(spoke.id)).size;
    } catch {
      offsets[spoke.id] = 0;
    }
  }
  return offsets;
}

function logMentionsPlan(spokeId: string, planId: string, offset = 0): boolean {
  try {
    const contents = fs.readFileSync(spokeLogPath(spokeId));
    const start = offset <= contents.length ? offset : 0;
    return contents.subarray(start).toString('utf-8').includes(planId);
  } catch {
    return false;
  }
}

/**
 * Return the id of the spoke working `planId`, or null. If more than one matches
 * (a crashed run left its log line behind after redelivery), prefer a spoke the
 * control center still reports as running.
 */
interface WorkingSpokeFilter {
  exclude?: readonly string[];
  offsets?: SpokeLogOffsets;
}

export async function detectWorkingSpoke(planId: string, filter: WorkingSpokeFilter = {}): Promise<string | null> {
  const spokes = await listSpokes();
  const excluded = new Set(filter.exclude ?? []);
  const candidates = spokes
    .filter((s) => !excluded.has(s.id) && logMentionsPlan(s.id, planId, filter.offsets?.[s.id] ?? 0))
    .map((s) => s.id);
  if (candidates.length === 0) return null;
  const running = new Set((await runningSpokes()).map((s) => s.id));
  const runningFirst = candidates.filter((c) => running.has(c));
  return (runningFirst.length > 0 ? runningFirst : candidates)[0]!;
}

/** Poll the spoke logs until one is seen working `planId`, or timeout. */
export async function awaitWorkingSpoke(
  planId: string,
  opts?: { timeout?: number; interval?: number; exclude?: readonly string[]; offsets?: SpokeLogOffsets },
): Promise<string | null> {
  const timeout = opts?.timeout ?? 180_000;
  const interval = opts?.interval ?? 3_000;

  const result = await pollUntil(
    () => detectWorkingSpoke(planId, { exclude: opts?.exclude, offsets: opts?.offsets }),
    (spoke) => spoke !== null,
    { timeout, interval },
  );
  return result;
}

export async function awaitSecondSpokePickup(
  planId: string,
  firstSpokeId: string,
  opts?: { timeout?: number; interval?: number; offsets?: SpokeLogOffsets },
): Promise<string | null> {
  return awaitWorkingSpoke(planId, {
    timeout: opts?.timeout,
    interval: opts?.interval,
    offsets: opts?.offsets,
    exclude: [firstSpokeId],
  });
}

// ---------------------------------------------------------------------------
// Bridge Redis: per-device saga lock + plan state
// ---------------------------------------------------------------------------

/**
 * True if the per-device saga lock exists in Redis (a worker holds the device).
 *
 * The TS bridge keys this `{zone}:lock:device:{device_id}` (zone prefix first --
 * NOT the Python port's `lock:{zone}:device:{id}`). Its presence means some worker
 * is mid-saga on this device; absence (after a crash) means the TTL lapsed and the
 * job is free to be re-picked by another spoke.
 */
export async function deviceLockHeld(deviceId: string): Promise<boolean> {
  const url = process.env.BRIDGE_REDIS_URL ?? 'redis://127.0.0.1:6379';
  const client = new Redis(url);
  try {
    const exists = await client.exists(bridgeRedisKey(`lock:device:${deviceId}`));
    return exists === 1;
  } finally {
    await client.quit();
  }
}

export async function expireDeviceLock(deviceId: string, ttlMs = 1): Promise<boolean> {
  const url = process.env.BRIDGE_REDIS_URL ?? 'redis://127.0.0.1:6379';
  const client = new Redis(url);
  try {
    return (await client.pexpire(bridgeRedisKey(`lock:device:${deviceId}`), ttlMs)) === 1;
  } finally {
    await client.quit();
  }
}

const SagaJobDataSchema = z.union([
  z.object({ plan_id: z.string() }).passthrough(),
  z.object({ aad: z.object({ job_id: z.string() }).passthrough() }).passthrough(),
]);

const LockWaitSnapshotSchema = z
  .object({
    first_blocked_at: z.number(),
    attempts: z.number().int().nonnegative(),
    lock_key: z.string(),
    plan_id: z.string().optional(),
  })
  .passthrough();

export type LockWaitSnapshot = z.infer<typeof LockWaitSnapshotSchema>;

export interface SagaQueueJobSnapshot {
  id: string;
  state: string;
  delayMs: number;
  attemptsMade: number;
  processedOn?: number;
  delayedScore: number | null;
  delayedUntilMs: number | null;
}

function bullmqPrefix(): string {
  return BRIDGE_ZONE_ID || 'bull';
}

function lifecycleQueueName(): string {
  return (process.env.BULLMQ_QUEUE_NAME ?? 'lifecycle').trim();
}

export async function getSagaQueueJob(planId: string): Promise<SagaQueueJobSnapshot | null> {
  const url = process.env.BRIDGE_REDIS_URL ?? 'redis://127.0.0.1:6379';
  const connection = new Redis(url, { maxRetriesPerRequest: null });
  const queueName = lifecycleQueueName();
  const prefix = bullmqPrefix();
  const queue = new Queue<Record<string, unknown>>(queueName, { prefix, connection });
  try {
    const jobs = await queue.getJobs(['active', 'delayed', 'wait', 'completed', 'failed'], 0, -1, false);
    for (const job of jobs) {
      const data = SagaJobDataSchema.safeParse(job.data);
      const dataPlanId = data.success ? ('plan_id' in data.data ? data.data.plan_id : data.data.aad.job_id) : null;
      if (dataPlanId !== planId || job.id === undefined) continue;
      const delayedScoreRaw = await connection.zscore(`${prefix}:${queueName}:delayed`, job.id);
      const delayedScore = delayedScoreRaw === null ? null : Number(delayedScoreRaw);
      return {
        id: job.id,
        state: await job.getState(),
        delayMs: job.delay,
        attemptsMade: job.attemptsMade,
        ...(job.processedOn === undefined ? {} : { processedOn: job.processedOn }),
        delayedScore,
        delayedUntilMs: delayedScore === null ? null : Math.floor(delayedScore / 4_096),
      };
    }
    return null;
  } finally {
    await queue.close();
    if (connection.status === 'ready') {
      await connection.quit();
    } else if (connection.status !== 'end') {
      connection.disconnect();
    }
  }
}

export async function awaitSagaQueueJobState(
  planId: string,
  expected: string,
  opts?: { timeout?: number; interval?: number },
): Promise<SagaQueueJobSnapshot | null> {
  return pollUntil(
    () => getSagaQueueJob(planId),
    (job) => job?.state === expected,
    { timeout: opts?.timeout ?? 180_000, interval: opts?.interval ?? 1_000 },
  );
}

export async function getLockWaitSnapshot(planId: string): Promise<LockWaitSnapshot | null> {
  const job = await getSagaQueueJob(planId);
  if (job === null) return null;
  const url = process.env.BRIDGE_REDIS_URL ?? 'redis://127.0.0.1:6379';
  const client = new Redis(url);
  try {
    const raw = await client.get(bridgeRedisKey(`lockwait:${job.id}`));
    if (raw === null) return null;
    return LockWaitSnapshotSchema.parse(JSON.parse(raw));
  } finally {
    await client.quit();
  }
}

const PlanSnapshotSchema = z
  .object({
    status: z.string().optional(),
    error: z.string().nullable().optional(),
    steps: z.array(z.record(z.string(), z.unknown())).default([]),
  })
  .passthrough();

export type PlanSnapshot = z.infer<typeof PlanSnapshotSchema>;

/**
 * Read the Redis-persisted lifecycle plan (`{JOB_KEY_PREFIX}:plan:{plan_id}`).
 *
 * Returns the decoded plan dict (steps + per-step status) or null if the plan
 * key is absent. The restart-resume test uses this to show the plan survived
 * the spoke restart and that steps advance rather than resetting to step 0.
 */
export async function getPlanSnapshot(planId: string): Promise<PlanSnapshot | null> {
  const url = process.env.BRIDGE_REDIS_URL ?? 'redis://127.0.0.1:6379';
  const client = new Redis(url);
  try {
    const raw = await client.get(`${JOB_KEY_PREFIX}:plan:${planId}`);
    if (raw === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return PlanSnapshotSchema.parse(parsed);
  } finally {
    await client.quit();
  }
}

/**
 * How many plan steps are COMPLETED, or 0 if the plan is unreadable.
 *
 * A coarse forward-progress gauge for the resume assertion -- the resumed saga
 * should not lose completed steps after the spoke restarts.
 */
export async function planCompletedStepCount(planId: string): Promise<number> {
  const plan = await getPlanSnapshot(planId);
  if (!plan) return 0;
  // The bridge persists a completed step's JobStatus.COMPLETED as the lowercase
  // string 'complete' (not 'completed') -- match that, else the count is always 0.
  return plan.steps.filter((s) => typeof s.status === 'string' && s.status.toLowerCase() === 'complete').length;
}
