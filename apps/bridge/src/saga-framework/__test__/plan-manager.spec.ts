import { isRecord } from '@repo/utils';
import { describe, expect, it } from 'vitest';

import {
  PlanManagerService,
  RedisLike,
  deserializeLifecyclePlan,
  serializeLifecyclePlan,
  transitionPlanStep,
} from '../plan-manager.service';
import type { LifecyclePlan, LifecyclePlanStep } from '../plan.types';
import { JobStatus } from '../state.types';

interface CacheCall {
  op: 'get' | 'set';
  key?: string;
  value?: string;
  ex?: number;
}

interface ScriptedOp {
  op: 'get' | 'set';
  expectedArgs?: { key?: string; ex?: number; value?: string };
  returns?: unknown;
  raises?: Error;
}

interface CacheHandle {
  cache: RedisLike;
  calls: CacheCall[];
}

function makeScriptedCache(ops: ScriptedOp[]): CacheHandle {
  const calls: CacheCall[] = [];
  const remaining = [...ops];
  const next = (op: 'get' | 'set'): ScriptedOp => {
    const scripted = remaining.shift();
    if (!scripted) throw new Error(`scripted cache ops exhausted but cache.${op} was called`);
    if (scripted.op !== op) {
      throw new Error(`scripted cache op mismatch: expected ${scripted.op}, got ${op}`);
    }
    return scripted;
  };
  const cache: RedisLike = {
    async get(key: string): Promise<string | Buffer | null> {
      const scripted = next('get');
      if (scripted.expectedArgs?.key !== undefined) {
        expect(key).toBe(scripted.expectedArgs.key);
      }
      calls.push({ op: 'get', key });
      if (scripted.raises) throw scripted.raises;
      return scripted.returns as string | Buffer | null;
    },
    async set(key: string, value: string, opts?: { ex?: number }): Promise<unknown> {
      const scripted = next('set');
      if (scripted.expectedArgs?.key !== undefined) {
        expect(key).toBe(scripted.expectedArgs.key);
      }
      if (scripted.expectedArgs?.ex !== undefined) {
        expect(opts?.ex).toBe(scripted.expectedArgs.ex);
      }
      if (scripted.expectedArgs?.value !== undefined) {
        expect(value).toBe(scripted.expectedArgs.value);
      }
      calls.push({ op: 'set', key, value, ex: opts?.ex });
      if (scripted.raises) throw scripted.raises;
      return scripted.returns;
    },
    async scan(): Promise<string[]> {
      return [];
    },
  };
  return { cache, calls };
}

function buildStep(name: string, overrides: Partial<LifecyclePlanStep> = {}): LifecyclePlanStep {
  return {
    step_name: name,
    operation: name,
    status: JobStatus.PENDING,
    created_at: 0,
    started_at: null,
    completed_at: null,
    error: null,
    result: null,
    job_id: null,
    queue_name: null,
    attempt: 0,
    ...overrides,
  };
}

function buildPlan(steps: LifecyclePlanStep[], overrides: Partial<LifecyclePlan> = {}): LifecyclePlan {
  return {
    plan_id: 'plan-1',
    device_id: 42,
    job_class: 'lifecycle',
    status: JobStatus.PENDING,
    created_at: 0,
    started_at: null,
    completed_at: null,
    error: null,
    metadata: {},
    steps,
    ...overrides,
  };
}

function parsePlan(json: string): LifecyclePlan {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error('expected serialized lifecycle plan');
  return deserializeLifecyclePlan(parsed);
}

const PREFIX = 'bridge';
const DEFAULT_TTL = 7200;
const KEY = `${PREFIX}:plan:plan-1`;

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function makeManager(redis: RedisLike, plan_ttl = DEFAULT_TTL): PlanManagerService {
  return new PlanManagerService({ redisKeyPrefix: PREFIX, defaultJobTtlSeconds: plan_ttl }, redis, silentLogger);
}

describe('plan-manager Pattern B: persist + retrieve round trip', () => {
  it('createPlanFromSaga then getPlan: set then get', async () => {
    const serialized = JSON.stringify(
      serializeLifecyclePlan(
        buildPlan([
          buildStep('validate', { status: JobStatus.COMPLETED }),
          buildStep('provision', { status: JobStatus.RUNNING }),
        ]),
      ),
    );

    const ops: ScriptedOp[] = [
      { op: 'set', returns: 'OK' },
      { op: 'get', returns: serialized },
    ];
    const { cache, calls } = makeScriptedCache(ops);
    const manager = makeManager(cache);

    const knownPlan = parsePlan(serialized);
    await manager.createPlanFromSaga({
      planId: knownPlan.plan_id,
      deviceId: knownPlan.device_id,
      jobClass: knownPlan.job_class,
      sagaDef: { name: 'irrelevant', steps: [] },
    });
    const retrieved = await manager.getPlan(knownPlan.plan_id);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.plan_id).toBe('plan-1');
    expect(retrieved?.steps.map((s) => s.step_name)).toEqual(['validate', 'provision']);
    expect(retrieved?.steps.map((s) => s.status)).toEqual([JobStatus.COMPLETED, JobStatus.RUNNING]);
    expect(calls.map((c) => c.op)).toEqual(['set', 'get']);
  });
});

describe('plan-manager Pattern B: TTL overrides', () => {
  it('uses device_health_check 60s override', async () => {
    const ops: ScriptedOp[] = [{ op: 'set', expectedArgs: { ex: 60, key: KEY }, returns: 'OK' }];
    const { cache, calls } = makeScriptedCache(ops);
    const manager = makeManager(cache);

    await manager.createPlanFromSaga({
      planId: 'plan-1',
      deviceId: 42,
      jobClass: 'device_health_check',
      sagaDef: { name: 'hc', steps: [{ name: 'ping', execute: async () => ({}) }] },
    });

    expect(calls[0].ex).toBe(60);
  });

  it('uses inventory_collection 3300s override', async () => {
    const ops: ScriptedOp[] = [{ op: 'set', expectedArgs: { ex: 3300 }, returns: 'OK' }];
    const { cache, calls } = makeScriptedCache(ops);
    const manager = makeManager(cache);

    await manager.createPlanFromSaga({
      planId: 'plan-1',
      deviceId: 42,
      jobClass: 'inventory_collection',
      sagaDef: { name: 'inv', steps: [{ name: 'scan', execute: async () => ({}) }] },
    });

    expect(calls[0].ex).toBe(3300);
  });

  it('falls back to default plan_ttl for unknown job class', async () => {
    const ops: ScriptedOp[] = [{ op: 'set', expectedArgs: { ex: 1234 }, returns: 'OK' }];
    const { cache, calls } = makeScriptedCache(ops);
    const manager = makeManager(cache, 1234);

    await manager.createPlanFromSaga({
      planId: 'plan-1',
      deviceId: 42,
      jobClass: 'some_brand_new_class',
      sagaDef: { name: 'x', steps: [{ name: 'op', execute: async () => ({}) }] },
    });

    expect(calls[0].ex).toBe(1234);
  });
});

describe('plan-manager Pattern B: redis is required', () => {
  it('throws when constructed without a RedisLike client', () => {
    expect(
      () => new PlanManagerService({ redisKeyPrefix: PREFIX, defaultJobTtlSeconds: DEFAULT_TTL }, null, silentLogger),
    ).toThrow(/PlanManagerService requires a RedisLike client/);
  });
});

describe('plan-manager Pattern B: cache call ordering', () => {
  it('updateStepStatus: get then set, persisted blob reflects transition', async () => {
    const initial = buildPlan([buildStep('validate'), buildStep('provision')]);
    const initialJson = JSON.stringify(serializeLifecyclePlan(initial));

    const ops: ScriptedOp[] = [
      { op: 'get', returns: initialJson },
      { op: 'set', returns: 'OK' },
    ];
    const { cache, calls } = makeScriptedCache(ops);
    const manager = makeManager(cache);

    await manager.updateStepStatus({
      planId: initial.plan_id,
      stepName: 'validate',
      status: JobStatus.COMPLETED,
      result: { validated: true },
    });

    expect(calls.map((c) => c.op)).toEqual(['get', 'set']);

    const setCall = calls[1];
    const persisted = JSON.parse(setCall.value as string) as {
      steps: Array<{ step_name: string; status: string; result: unknown }>;
    };
    const validate = persisted.steps.find((s) => s.step_name === 'validate');
    expect(validate?.status).toBe(JobStatus.COMPLETED);
    expect(validate?.result).toEqual({ validated: true });
  });

  it('rewindPlan: get then set, attempt incremented and status RUNNING', async () => {
    const initial = buildPlan(
      [
        buildStep('wipe', { status: JobStatus.COMPLETED }),
        buildStep('install', { status: JobStatus.FAILED, attempt: 0 }),
      ],
      { status: JobStatus.FAILED },
    );
    const initialJson = JSON.stringify(serializeLifecyclePlan(initial));

    const ops: ScriptedOp[] = [
      { op: 'get', returns: initialJson },
      { op: 'set', returns: 'OK' },
    ];
    const { cache, calls } = makeScriptedCache(ops);
    const manager = makeManager(cache);

    const rewound = await manager.rewindPlan({
      planId: initial.plan_id,
      rewindTo: 'wipe',
      failedStep: 'install',
    });

    expect(rewound).not.toBeNull();
    expect(calls.map((c) => c.op)).toEqual(['get', 'set']);
    const install = rewound?.steps.find((s) => s.step_name === 'install');
    expect(install?.attempt).toBe(1);
    expect(install?.status).toBe(JobStatus.PENDING);
  });

  it('corrupt Redis payload: warns and falls back to in-memory copy', async () => {
    const plan = buildPlan([buildStep('op')]);
    const ops: ScriptedOp[] = [{ op: 'get', returns: '{not-json' }];
    const { cache, calls } = makeScriptedCache(ops);

    const warns: string[] = [];
    const manager = new PlanManagerService({ redisKeyPrefix: PREFIX, defaultJobTtlSeconds: DEFAULT_TTL }, cache, {
      info: () => undefined,
      warn: (m) => warns.push(m),
      error: () => undefined,
    });
    (manager as unknown as { plans: Map<string, LifecyclePlan> }).plans.set(plan.plan_id, plan);

    const retrieved = await manager.getPlan(plan.plan_id);

    expect(retrieved).toBe(plan);
    expect(calls.map((c) => c.op)).toEqual(['get']);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('Failed to decode lifecycle plan');
  });

  it('Redis miss: returns in-memory copy', async () => {
    const plan = buildPlan([buildStep('op')]);
    const ops: ScriptedOp[] = [{ op: 'get', returns: null }];
    const { cache, calls } = makeScriptedCache(ops);
    const manager = makeManager(cache);
    (manager as unknown as { plans: Map<string, LifecyclePlan> }).plans.set(plan.plan_id, plan);

    const retrieved = await manager.getPlan(plan.plan_id);
    expect(retrieved).toBe(plan);
    expect(calls.map((c) => c.op)).toEqual(['get']);
  });

  it('persist warns on Redis set failure but keeps in-memory mirror', async () => {
    const ops: ScriptedOp[] = [{ op: 'set', raises: new Error('boom') }];
    const { cache, calls } = makeScriptedCache(ops);

    const warns: string[] = [];
    const manager = new PlanManagerService({ redisKeyPrefix: PREFIX, defaultJobTtlSeconds: DEFAULT_TTL }, cache, {
      info: () => undefined,
      warn: (m) => warns.push(m),
      error: () => undefined,
    });

    const plan = await manager.createPlanFromSaga({
      planId: 'plan-1',
      deviceId: 42,
      jobClass: 'lifecycle',
      sagaDef: { name: 's', steps: [{ name: 'op', execute: async () => ({}) }] },
    });

    expect(calls.map((c) => c.op)).toEqual(['set']);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('Failed to persist lifecycle plan');
    const internal = manager as unknown as { plans: Map<string, LifecyclePlan> };
    expect(internal.plans.get(plan.plan_id)?.plan_id).toBe('plan-1');
  });
});

describe('PlanManagerService.failPlan', () => {
  it('does nothing when the plan is missing', async () => {
    const { cache, calls } = makeScriptedCache([{ op: 'get', returns: null }]);
    const manager = makeManager(cache);

    await manager.failPlan('missing-plan', 'lock lost');

    expect(calls.map((call) => call.op)).toEqual(['get']);
  });

  it('persists a terminal failure and cancels all non-terminal steps while preserving terminal steps', async () => {
    const terminalSteps = [
      buildStep('complete', {
        status: JobStatus.COMPLETED,
        created_at: 1,
        started_at: 2,
        completed_at: 3,
        result: { ok: true },
      }),
      buildStep('failed', {
        status: JobStatus.FAILED,
        created_at: 1,
        started_at: 4,
        completed_at: 5,
        error: 'existing failure',
      }),
      buildStep('cancelled', {
        status: JobStatus.CANCELLED,
        created_at: 1,
        completed_at: 6,
        error: 'existing cancellation',
      }),
    ];
    const initial = buildPlan(
      [
        buildStep('pending'),
        buildStep('running', { status: JobStatus.RUNNING, started_at: 7 }),
        buildStep('blocked', { status: JobStatus.BLOCKED }),
        ...terminalSteps,
      ],
      { status: JobStatus.BLOCKED, started_at: 7 },
    );
    const ops: ScriptedOp[] = [
      { op: 'get', returns: JSON.stringify(serializeLifecyclePlan(initial)) },
      { op: 'set', returns: 'OK' },
    ];
    const { cache, calls } = makeScriptedCache(ops);
    const manager = makeManager(cache);
    const before = Date.now() / 1000;

    await manager.failPlan(initial.plan_id, 'device lock lost');

    const after = Date.now() / 1000;
    expect(calls.map((call) => call.op)).toEqual(['get', 'set']);
    const persisted = parsePlan(calls[1].value ?? '{}');
    expect(persisted.status).toBe(JobStatus.FAILED);
    expect(persisted.error).toBe('device lock lost');
    expect(persisted.completed_at).toBeGreaterThanOrEqual(before);
    expect(persisted.completed_at).toBeLessThanOrEqual(after);
    const cancelledSteps = persisted.steps.slice(0, 3);
    expect(cancelledSteps.map((step) => step.status)).toEqual([
      JobStatus.CANCELLED,
      JobStatus.CANCELLED,
      JobStatus.CANCELLED,
    ]);
    expect(cancelledSteps.every((step) => step.completed_at !== null && step.completed_at >= before)).toBe(true);
    expect(cancelledSteps.every((step) => step.completed_at !== null && step.completed_at <= after)).toBe(true);
    expect(persisted.steps.slice(3)).toEqual(terminalSteps);
  });
});

describe('plan-manager Pattern B: in-memory cache is bounded', () => {
  it('caps the in-memory map size across many distinct plan_ids', async () => {
    const PLAN_COUNT = 12_000;
    const ops: ScriptedOp[] = Array.from({ length: PLAN_COUNT }, () => ({ op: 'set', returns: 'OK' }));
    const { cache } = makeScriptedCache(ops);
    const manager = makeManager(cache);

    for (let i = 0; i < PLAN_COUNT; i++) {
      await manager.createPlanFromSaga({
        planId: `plan-${i}`,
        deviceId: i,
        jobClass: 'lifecycle',
        sagaDef: { name: 's', steps: [{ name: 'op', execute: async () => ({}) }] },
      });
    }

    const internal = manager as unknown as { plans: { size: number; get(id: string): unknown } };
    expect(internal.plans.size).toBeLessThanOrEqual(5000);
    expect(internal.plans.get(`plan-${PLAN_COUNT - 1}`)).not.toBeUndefined();
    expect(internal.plans.get('plan-0')).toBeUndefined();
  });

  it('cold lookup (evicted from cache) still resolves from Redis', async () => {
    const plan = buildPlan([buildStep('op')], { plan_id: 'cold-plan' });
    const serialized = JSON.stringify(serializeLifecyclePlan(plan));
    const ops: ScriptedOp[] = [{ op: 'get', returns: serialized }];
    const { cache, calls } = makeScriptedCache(ops);
    const manager = makeManager(cache);

    const retrieved = await manager.getPlan('cold-plan');

    expect(retrieved).not.toBeNull();
    expect(retrieved?.plan_id).toBe('cold-plan');
    expect(calls.map((c) => c.op)).toEqual(['get']);
  });
});

describe('transitionPlanStep: unknown step is a no-op', () => {
  it('returns the plan unchanged when stepName matches no step', () => {
    const plan = buildPlan(
      [
        buildStep('validate', { status: JobStatus.COMPLETED, started_at: 1, completed_at: 2 }),
        buildStep('provision', { status: JobStatus.RUNNING, started_at: 3 }),
      ],
      {
        status: JobStatus.PENDING,
        started_at: 10,
        completed_at: 20,
        error: 'pre-existing error',
      },
    );

    const result = transitionPlanStep(plan, {
      stepName: 'does-not-exist',
      status: JobStatus.COMPLETED,
      error: 'should be ignored',
      now: 9999,
    });

    expect(result).toBe(plan);
    expect(result.status).toBe(JobStatus.PENDING);
    expect(result.started_at).toBe(10);
    expect(result.completed_at).toBe(20);
    expect(result.error).toBe('pre-existing error');
    expect(result.steps).toBe(plan.steps);
    expect(result.steps.map((s) => s.status)).toEqual([JobStatus.COMPLETED, JobStatus.RUNNING]);
  });

  it('still transitions a matching step (happy path unchanged)', () => {
    const plan = buildPlan([buildStep('validate'), buildStep('provision')]);

    const result = transitionPlanStep(plan, {
      stepName: 'validate',
      status: JobStatus.COMPLETED,
      now: 100,
    });

    expect(result).not.toBe(plan);
    const validate = result.steps.find((s) => s.step_name === 'validate');
    expect(validate?.status).toBe(JobStatus.COMPLETED);
  });
});

describe('plan-manager Pattern B: serialize round-trip', () => {
  it('serialize -> JSON -> deserialize -> serialize is stable', () => {
    const plan = buildPlan(
      [
        buildStep('a', { status: JobStatus.COMPLETED, attempt: 2, created_at: 500 }),
        buildStep('b', { status: JobStatus.RUNNING, started_at: 100, created_at: 500 }),
      ],
      {
        status: JobStatus.RUNNING,
        created_at: 1000,
        metadata: { saga_name: 'provision' },
      },
    );

    const json = JSON.stringify(serializeLifecyclePlan(plan));
    const reparsed = parsePlan(json);
    const json2 = JSON.stringify(serializeLifecyclePlan(reparsed));
    expect(json2).toBe(json);
  });
});
