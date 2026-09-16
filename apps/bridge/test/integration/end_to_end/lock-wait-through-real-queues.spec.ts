import { randomUUID } from 'node:crypto';

import { Queue, type Job } from 'bullmq';
import Redis from 'ioredis';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { resetBullmqProcessorForTests, setBullmqProcessor } from '../../../src/bullmq/bullmq-processor-singleton';
import { buildBullmqConfig } from '../../../src/bullmq/bullmq.config';
import { AGENT_HANDOFF_REDELAY_SECONDS } from '../../../src/bullmq/bullmq.types';
import { BullmqProcessorService } from '../../../src/bullmq/handlers.service';
import { SagaJobHandler, type SagaHandlerLogger } from '../../../src/bullmq/saga.handler';
import { createIoredisDriverFactory } from '../../../src/common/redis/redis-client/ioredis-driver';
import { loadRedisConfig } from '../../../src/common/redis/redis-client/redis.config';
import { RedisService } from '../../../src/common/redis/redis.service';
import { createLifecycleWorker } from '../../../src/composition/bullmq-factories';
import { NotificationsService, type ResultsQueueProducer } from '../../../src/saga-framework/notifications.service';
import { PlanManagerService, type RedisLike } from '../../../src/saga-framework/plan-manager.service';
import { SagaRegistryService } from '../../../src/saga-framework/saga-registry';
import { SagaRunnerService } from '../../../src/saga-framework/saga-runner.service';
import type { SagaDef } from '../../../src/saga-framework/saga.types';
import { JobStatus } from '../../../src/saga-framework/state.types';

vi.unmock('bullmq');
vi.unmock('ioredis');

const LockWaitStateSchema = z.object({
  first_blocked_at: z.number(),
  attempts: z.number().int().positive(),
  lock_key: z.string(),
  holder_plan_id: z.string().optional(),
  holder_saga_name: z.string().optional(),
  holder_since: z.string().optional(),
});

const silentLogger: SagaHandlerLogger = {
  debug: async () => {},
  info: async () => {},
  warning: async () => {},
  error: async () => {},
};

const resultsProducer: ResultsQueueProducer = {
  enqueueResult: async () => true,
  enqueueJobCompleted: async () => true,
};

class RealPlanRedis implements RedisLike {
  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, opts?: { ex?: number }): Promise<unknown> {
    if (opts?.ex !== undefined) return this.redis.set(key, value, 'EX', opts.ex);
    return this.redis.set(key, value);
  }

  async scan(pattern: string): Promise<string[]> {
    let cursor = '0';
    const keys: string[] = [];
    do {
      const [nextCursor, batch] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== '0');
    return keys;
  }

  async compareAndSet(key: string, expectedValue: string, value: string, ttl: number): Promise<boolean> {
    const result = await this.redis.eval(
      'if redis.call("get",KEYS[1])==ARGV[1] then redis.call("set",KEYS[1],ARGV[2],"EX",ARGV[3]); return 1 elseif redis.call("get",KEYS[1])==ARGV[2] then return 1 else return 0 end',
      1,
      key,
      expectedValue,
      value,
      String(ttl),
    );
    return result === 1;
  }
}

interface Harness {
  prefix: string;
  queueName: string;
  queue: Queue<Record<string, unknown>>;
  redis: Redis;
  cache: RedisService;
  planManager: PlanManagerService;
  worker: ReturnType<typeof createLifecycleWorker>;
  workerRun: Promise<void>;
  executionCount: () => number;
}

const activeHarnesses: Harness[] = [];

function redisUrl(): string {
  return process.env.REDIS_URL ?? process.env.BRIDGE_REDIS_URL ?? 'redis://127.0.0.1:6379/0';
}

async function probeRedisAvailable(): Promise<boolean> {
  const probe = new Redis(redisUrl(), {
    connectTimeout: 1_000,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
  });
  probe.on('error', () => {});
  try {
    await probe.connect();
    const pong = await probe.ping();
    return pong === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

let redisAvailable = false;

beforeAll(async () => {
  redisAvailable = await probeRedisAvailable();
});

beforeEach((ctx) => {
  if (!redisAvailable) ctx.skip();
});

async function removePrefix(redis: Redis, prefix: string): Promise<void> {
  const stream = redis.scanStream({ match: `${prefix}:*`, count: 100 });
  for await (const keys of stream) {
    if (keys.length > 0) await redis.del(...keys);
  }
}

async function waitForJobState(
  queue: Queue<Record<string, unknown>>,
  jobId: string,
  expected: string,
  timeoutMs = 20_000,
): Promise<Job<Record<string, unknown>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await queue.getJob(jobId);
    if (job !== undefined && (await job.getState()) === expected) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const job = await queue.getJob(jobId);
  const state = job === undefined ? 'missing' : await job.getState();
  throw new Error(`job ${jobId} did not reach ${expected}; state=${state}`);
}

async function makeHarness(lockWaitHardCapSeconds: number): Promise<Harness> {
  const id = randomUUID().replaceAll('-', '');
  const prefix = `lockwait-real-${id}`;
  const queueName = `lifecycle-${id}`;
  const url = redisUrl();
  const redis = new Redis(url, { maxRetriesPerRequest: null });
  await redis.ping();

  const redisConfig = { ...loadRedisConfig({ ...process.env, REDIS_URL: url }), prefix };
  const cache = new RedisService(redisConfig, createIoredisDriverFactory(redisConfig));
  await cache.requireConnection(1, 0);
  const planManager = new PlanManagerService(
    { redisKeyPrefix: `${prefix}:bridge:test`, defaultJobTtlSeconds: 300 },
    new RealPlanRedis(redis),
  );
  const registry = new SagaRegistryService();
  let executions = 0;
  const saga: SagaDef = {
    name: 'provision',
    steps: [
      {
        name: 'run',
        operation: 'Run',
        execute: async () => {
          executions += 1;
          return { ok: true };
        },
      },
    ],
  };
  registry.register(saga);
  const notifications = new NotificationsService(resultsProducer);
  const runner = new SagaRunnerService(planManager, notifications);
  const handlerConfig = {
    bullmqQueueName: queueName,
    deviceLockTimeoutSeconds: 60,
    deviceLockRenewIntervalSeconds: 20,
    lockWaitWarningSeconds: 0,
    lockWaitHardCapSeconds,
  };
  const handler = new SagaJobHandler(
    cache,
    planManager,
    runner,
    registry,
    {},
    handlerConfig,
    { clearCooldownAndEnqueue: async () => {} },
    silentLogger,
  );
  const processor = new BullmqProcessorService(
    { 'saga.run': handler.handle },
    { open: async (job) => ({ payload: job.data, createdAtMs: Date.now(), isBridgeLocal: false }) },
    silentLogger,
    {
      lockWaitWarningSeconds: 0,
      lockWaitHardCapSeconds,
      agentWaitHardCapSeconds: 0,
      lockLostRedelaySeconds: 90,
    },
    cache,
    planManager,
    notifications,
  );
  setBullmqProcessor(processor);

  const config = buildBullmqConfig({
    ...process.env,
    BROKKR_ZONE_ID: prefix,
    BULLMQ_QUEUE_NAME: queueName,
    LIFECYCLE_WORKER_CONCURRENCY: '1',
    DEVICE_LOCK_TIMEOUT_SECONDS: '60',
    DEVICE_LOCK_RENEW_INTERVAL_SECONDS: '20',
    LOCK_WAIT_WARNING_SECONDS: '0',
    LOCK_WAIT_HARD_CAP_SECONDS: String(lockWaitHardCapSeconds),
  });
  const worker = createLifecycleWorker({ config, redisConfig });
  const workerRun = worker.run();
  const queue = new Queue<Record<string, unknown>>(queueName, {
    prefix,
    connection: {
      host: redisConfig.host,
      port: redisConfig.port,
      db: redisConfig.db,
      username: redisConfig.username || undefined,
      password: redisConfig.password || undefined,
      maxRetriesPerRequest: null,
    },
  });
  const harness = {
    prefix,
    queueName,
    queue,
    redis,
    cache,
    planManager,
    worker,
    workerRun,
    executionCount: () => executions,
  };
  activeHarnesses.push(harness);
  return harness;
}

async function enqueueSaga(harness: Harness, jobId: string, planId: string, deviceId: string): Promise<void> {
  await harness.queue.add(
    'saga.run',
    {
      plan_id: planId,
      saga_name: 'provision',
      payload: { device_id: deviceId },
    },
    {
      jobId,
      attempts: 8,
      removeOnComplete: false,
      removeOnFail: false,
    },
  );
}

afterEach(async () => {
  for (const harness of activeHarnesses.splice(0)) {
    await harness.worker.close(true);
    await harness.workerRun;
    await harness.queue.close();
    await harness.cache.close();
    await removePrefix(harness.redis, harness.prefix);
    await harness.redis.quit();
  }
  resetBullmqProcessorForTests();
});

describe('lock wait through real Redis and BullMQ', () => {
  it('persists contention, redelays without an attempt, and reacquires after release', async () => {
    const harness = await makeHarness(30);
    const jobId = `job-${randomUUID()}`;
    const planId = `plan-${randomUUID()}`;
    const deviceId = `device-${randomUUID()}`;
    const lockKey = `device:${deviceId}`;
    const holderSince = new Date().toISOString();
    const lock = await harness.cache.acquireLock(lockKey, 30, 'holder-plan', {
      plan_id: 'holder-plan',
      saga_name: 'provision',
      acquired_at: holderSince,
    });
    expect(lock).not.toBeNull();

    await enqueueSaga(harness, jobId, planId, deviceId);
    const delayed = await waitForJobState(harness.queue, jobId, 'delayed');
    const rawState = await harness.redis.get(`${harness.prefix}:lockwait:${jobId}`);
    expect(rawState).not.toBeNull();
    const lockWait = LockWaitStateSchema.parse(JSON.parse(rawState ?? 'null'));
    expect(lockWait).toMatchObject({
      attempts: 1,
      lock_key: lockKey,
      holder_plan_id: 'holder-plan',
      holder_saga_name: 'provision',
      holder_since: holderSince,
    });
    expect(delayed.attemptsMade).toBe(0);
    expect(delayed.delay).toBe(AGENT_HANDOFF_REDELAY_SECONDS * 1_000);
    expect(await harness.redis.zscore(`${harness.prefix}:${harness.queueName}:delayed`, jobId)).not.toBeNull();

    await harness.cache.releaseLock(lockKey, lock ?? '', 'holder-plan');
    const completed = await waitForJobState(harness.queue, jobId, 'completed');
    expect(completed.attemptsMade).toBe(1);
    expect(harness.executionCount()).toBe(1);
    expect(await harness.redis.get(`${harness.prefix}:lockwait:${jobId}`)).toBeNull();
    expect((await harness.planManager.getPlan(planId))?.status).toBe(JobStatus.COMPLETED);
  }, 25_000);

  it('fails the plan at the lock-wait hard cap instead of redelivering', async () => {
    const harness = await makeHarness(1);
    const jobId = `job-${randomUUID()}`;
    const planId = `plan-${randomUUID()}`;
    const deviceId = `device-${randomUUID()}`;
    const lockKey = `device:${deviceId}`;
    const lock = await harness.cache.acquireLock(lockKey, 30, 'holder-plan', {
      plan_id: 'holder-plan',
      saga_name: 'provision',
      acquired_at: new Date().toISOString(),
    });
    expect(lock).not.toBeNull();
    await harness.cache.set(
      `lockwait:${jobId}`,
      JSON.stringify({
        first_blocked_at: Date.now() / 1_000 - 2,
        attempts: 1,
        lock_key: lockKey,
        last_notified_at: 0,
      }),
      60,
      planId,
    );

    await enqueueSaga(harness, jobId, planId, deviceId);
    const failed = await waitForJobState(harness.queue, jobId, 'failed');
    const plan = await harness.planManager.getPlan(planId);
    expect(failed.attemptsMade).toBe(1);
    expect(plan?.status).toBe(JobStatus.FAILED);
    expect(plan?.error).toContain('Lock wait exceeded hard cap');
    expect(await harness.redis.zscore(`${harness.prefix}:${harness.queueName}:delayed`, jobId)).toBeNull();
    const terminalLockWait = await harness.redis.get(`${harness.prefix}:lockwait:${jobId}`);
    expect(terminalLockWait).not.toBeNull();
    expect(LockWaitStateSchema.parse(JSON.parse(terminalLockWait ?? 'null')).attempts).toBe(2);
    expect(harness.executionCount()).toBe(0);

    await harness.cache.releaseLock(lockKey, lock ?? '', 'holder-plan');
  }, 15_000);
});
