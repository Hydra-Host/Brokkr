
import { beforeEach, describe, expect, it } from 'vitest';

import type { ProcessableJob } from '../../../../src/bullmq/handlers.service';
import type {
  SagaCooldownClearer,
  SagaHandlerCache,
  SagaHandlerConfig,
  SagaHandlerLogger,
} from '../../../../src/bullmq/saga.handler';
import { SagaJobHandler } from '../../../../src/bullmq/saga.handler';
import { deviceSagaLock } from '../../../../src/common/redis/redis-keys';
import {
  NotificationsService,
  type EventType,
  type ResultsQueueProducer,
} from '../../../../src/saga-framework/notifications.service';
import { PlanManagerService, type RedisLike } from '../../../../src/saga-framework/plan-manager.service';
import { SagaRegistryService } from '../../../../src/saga-framework/saga-registry';
import { SagaRunnerService } from '../../../../src/saga-framework/saga-runner.service';
import type { RecoveryAction, SagaContext, SagaDef } from '../../../../src/saga-framework/saga.types';
import { JobStatus } from '../../../../src/saga-framework/state.types';

type Scripted = readonly [operation: string, response: unknown];

interface DispatchCall {
  operation: string;
  input: unknown;
  context: { deviceId: string; jobId?: string };
}

class FakeAgent {
  readonly calls: DispatchCall[] = [];
  private readonly scripted: Scripted[];

  constructor(scripted: readonly Scripted[]) {
    this.scripted = [...scripted];
  }

  async dispatch(
    deviceId: string,
    operation: string,
    input: unknown,
    extra: { jobId?: string } = {},
  ): Promise<unknown> {
    this.calls.push({ operation, input, context: { deviceId, jobId: extra.jobId } });
    const next = this.scripted.shift();
    if (next === undefined) {
      throw new Error(`FakeAgent: no scripted response left for operation '${operation}'`);
    }
    const [expectedOp, response] = next;
    if (expectedOp !== operation) {
      throw new Error(`FakeAgent: expected operation '${expectedOp}', got '${operation}'`);
    }
    if (response instanceof Error) throw response;
    return response;
  }
}

class InMemoryCache implements SagaHandlerCache {
  private readonly locks = new Map<string, string>();
  private tokenCounter = 0;

  rawLockKey(lockKey: string): string {
    return `lock:${lockKey}`;
  }

  async acquireLock(lockKey: string): Promise<string | null> {
    const key = this.rawLockKey(lockKey);
    if (this.locks.has(key)) return null;
    this.tokenCounter += 1;
    const token = `tok-${this.tokenCounter}`;
    this.locks.set(key, token);
    return token;
  }

  async releaseLock(lockKey: string, token: string): Promise<boolean> {
    const key = this.rawLockKey(lockKey);
    if (this.locks.get(key) !== token) return false;
    this.locks.delete(key);
    return true;
  }

  async renewLockIfOwner(lockKey: string, expectedValue: string): Promise<boolean> {
    return this.locks.get(this.rawLockKey(lockKey)) === expectedValue;
  }

  has(rawKey: string): boolean {
    return this.locks.has(rawKey);
  }
}

interface RecordedResult {
  planId: string;
  stepName: string;
  status: string;
  deviceId: unknown;
  eventType: EventType;
  actionType: string;
  result?: unknown;
  error?: string | null;
  attempt: number;
  metadata: Record<string, unknown>;
}

interface RecordedJobCompleted {
  planId: string;
  deviceId: unknown;
  sagaName: string;
  status: string;
  error?: string | null;
  metadata: Record<string, unknown>;
}

class InMemoryResultsProducer implements ResultsQueueProducer {
  readonly results: RecordedResult[] = [];
  readonly completions: RecordedJobCompleted[] = [];

  async enqueueResult(args: RecordedResult): Promise<boolean> {
    this.results.push({ ...args, metadata: { ...args.metadata } });
    return true;
  }

  async enqueueJobCompleted(args: RecordedJobCompleted): Promise<boolean> {
    this.completions.push({ ...args, metadata: { ...args.metadata } });
    return true;
  }
}

class RecordingCooldownClearer implements SagaCooldownClearer {
  readonly calls: Array<{ deviceId: string; jobId: string }> = [];
  async clearCooldownAndEnqueue(deviceId: string, jobId: string): Promise<void> {
    this.calls.push({ deviceId, jobId });
  }
}

const SAGA_NAME = 'e2e_test_saga';

function buildTestSaga(agent: FakeAgent): SagaDef {
  const stepPing = async (ctx: SagaContext): Promise<unknown> => {
    const result = await agent.dispatch(
      String(ctx.deviceId),
      'agent.ping',
      {
        device_id: String(ctx.deviceId),
      },
      { jobId: ctx.jobId },
    );
    return { ping: result };
  };

  const stepFlaky = async (ctx: SagaContext): Promise<unknown> => {
    const result = await agent.dispatch(
      String(ctx.deviceId),
      'agent.flaky',
      {
        attempt: ctx.attempt,
      },
      { jobId: ctx.jobId },
    );
    return { flaky: result };
  };

  const stepFinalize = async (ctx: SagaContext): Promise<unknown> => {
    const result = await agent.dispatch(
      String(ctx.deviceId),
      'agent.finalize',
      {
        prior: ctx.stepResults.ping,
      },
      { jobId: ctx.jobId },
    );
    return { finalize: result };
  };

  const flakyRecovery: RecoveryAction[] = [{ rewindTo: 'flaky', description: 'Retry flaky step' }];

  return {
    name: SAGA_NAME,
    steps: [
      { name: 'ping', operation: 'Ping agent', execute: stepPing },
      {
        name: 'flaky',
        operation: 'Flaky step (first attempt fails)',
        execute: stepFlaky,
        maxAttempts: 2,
        recovery: flakyRecovery,
      },
      { name: 'finalize', operation: 'Finalize via agent', execute: stepFinalize },
    ],
  };
}

const SCRIPTED_HAPPY_PATH: readonly Scripted[] = [
  ['agent.ping', { ok: true, rtt_ms: 4 }],
  ['agent.flaky', new Error('transient agent error')],
  ['agent.flaky', { recovered: true }],
  ['agent.finalize', { committed: true }],
];

interface Harness {
  agent: FakeAgent;
  cache: InMemoryCache;
  planManager: PlanManagerService;
  producer: InMemoryResultsProducer;
  cooldownClearer: RecordingCooldownClearer;
  handler: SagaJobHandler;
  saga: SagaDef;
}

const silentLogger: SagaHandlerLogger = {
  debug: async () => {},
  info: async () => {},
  warning: async () => {},
  error: async () => {},
};

function makeHarness(scripted: readonly Scripted[] = SCRIPTED_HAPPY_PATH): Harness {
  const agent = new FakeAgent(scripted);
  const saga = buildTestSaga(agent);

  const registry = new SagaRegistryService();
  registry.register(saga);

  const cache = new InMemoryCache();
  const planRedis: RedisLike = (() => {
    const store = new Map<string, string>();
    return {
      async get(key) {
        return store.get(key) ?? null;
      },
      async set(key, value) {
        store.set(key, value);
        return 'OK';
      },
      async scan(pattern) {
        const prefix = pattern.slice(0, -1);
        return [...store.keys()].filter((key) => key.startsWith(prefix));
      },
    };
  })();
  const planManager = new PlanManagerService({ redisKeyPrefix: 'bridge:test', defaultJobTtlSeconds: 3600 }, planRedis);
  const producer = new InMemoryResultsProducer();
  const notifications = new NotificationsService(producer);
  const runner = new SagaRunnerService(planManager, notifications);

  const config: SagaHandlerConfig = {
    bullmqQueueName: 'lifecycle',
    deviceLockTimeoutSeconds: 30,
    deviceLockRenewIntervalSeconds: 10,
  };

  const cooldownClearer = new RecordingCooldownClearer();
  const handler = new SagaJobHandler(cache, planManager, runner, registry, {}, config, cooldownClearer, silentLogger);

  return { agent, cache, planManager, producer, cooldownClearer, handler, saga };
}

function makeJob(
  planId: string,
  deviceId: number | string,
  sagaName = SAGA_NAME,
): ProcessableJob<Record<string, unknown>> {
  return {
    id: planId,
    name: 'saga',
    data: {
      plan_id: planId,
      saga_name: sagaName,
      payload: { device_id: deviceId },
    },
    queue: { name: 'lifecycle' },
    scripts: {
      moveToDelayed: async () => undefined,
    },
  };
}

describe('integration/end_to_end: saga through queues', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = makeHarness();
  });

  it('saga executes end-to-end (plan completes, dispatcher saw every scripted op)', async () => {
    const planId = 'e2e-plan-001';
    const deviceId = 4242;

    const result = await harness.handler.handle(makeJob(planId, deviceId));

    expect(result).toEqual({ plan_id: planId, status: JobStatus.COMPLETED });

    const plan = await harness.planManager.getPlan(planId);
    expect(plan).not.toBeNull();
    expect(plan?.status).toBe(JobStatus.COMPLETED);

    const stepStatus = Object.fromEntries((plan?.steps ?? []).map((s) => [s.step_name, s.status]));
    expect(stepStatus).toEqual({
      ping: JobStatus.COMPLETED,
      flaky: JobStatus.COMPLETED,
      finalize: JobStatus.COMPLETED,
    });

    const operations = harness.agent.calls.map((c) => c.operation);
    expect(operations).toEqual(['agent.ping', 'agent.flaky', 'agent.flaky', 'agent.finalize']);

    const flaky = (plan?.steps ?? []).find((s) => s.step_name === 'flaky');
    expect(flaky?.attempt).toBe(1);
  });

  it('per-device lock acquired and released around the saga', async () => {
    const planId = 'e2e-lock-001';
    const deviceId = 4243;

    await harness.handler.handle(makeJob(planId, deviceId));

    const plan = await harness.planManager.getPlan(planId);
    expect(plan?.status).toBe(JobStatus.COMPLETED);

    const rawLockKey = `lock:${deviceSagaLock(String(deviceId))}`;
    expect(harness.cache.has(rawLockKey)).toBe(false);

    expect(harness.cooldownClearer.calls).toEqual([{ deviceId: String(deviceId), jobId: planId }]);
  });

  it('recovery rewind replays failed step (attempt counter increments, result reflects retry)', async () => {
    const planId = 'e2e-rewind-001';
    const deviceId = 4244;

    await harness.handler.handle(makeJob(planId, deviceId));

    const plan = await harness.planManager.getPlan(planId);
    expect(plan?.status).toBe(JobStatus.COMPLETED);

    const flaky = (plan?.steps ?? []).find((s) => s.step_name === 'flaky');
    expect(flaky?.status).toBe(JobStatus.COMPLETED);
    expect(flaky?.attempt).toBe(1);
    expect(flaky?.result).toEqual({ flaky: { recovered: true } });
  });

  it('results queue receives step transitions and the terminal job_completed event', async () => {
    const planId = 'e2e-results-001';
    const deviceId = 4245;

    await harness.handler.handle(makeJob(planId, deviceId));

    const plan = await harness.planManager.getPlan(planId);
    expect(plan?.status).toBe(JobStatus.COMPLETED);

    const planEntries = harness.producer.results.filter((r) => r.planId === planId);
    expect(planEntries.length).toBeGreaterThan(0);

    for (const entry of planEntries) {
      expect(entry.planId).toBe(planId);
      expect(entry.actionType).toBe(SAGA_NAME);
    }

    const completion = harness.producer.completions.find((c) => c.planId === planId);
    expect(completion).toBeDefined();
    expect(completion?.status).toBe(JobStatus.COMPLETED);
    expect(completion?.sagaName).toBe(SAGA_NAME);

    const finalizeCompleted = planEntries.find((e) => e.stepName === 'finalize' && e.status === JobStatus.COMPLETED);
    expect(finalizeCompleted).toBeDefined();
  });
});
