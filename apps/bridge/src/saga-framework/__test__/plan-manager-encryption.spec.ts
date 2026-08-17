import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RedisEncryptor } from '../../common/redis/redis-client/redis-encryptor.js';
import {
  PlanManagerService,
  type RedisLike,
  serializeLifecyclePlan,
} from '../plan-manager.service.js';
import type { LifecyclePlan, LifecyclePlanStep } from '../plan.types.js';
import { JobStatus } from '../state.types.js';

class MemoryRedis implements RedisLike {
  readonly values = new Map<string, string>();
  setCalls = 0;

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    this.setCalls += 1;
    this.values.set(key, value);
    return 'OK';
  }

  async scan(pattern: string): Promise<string[]> {
    const prefix = pattern.slice(0, -1);
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }
}

const NOW = 1_800_000_000;
const PREFIX = 'bridge:jobs';
const SILENT = { info: () => {}, warn: () => {}, error: () => {} };

function step(status = JobStatus.PENDING, startedAt: number | null = null): LifecyclePlanStep {
  return {
    step_name: 'step',
    operation: 'operation',
    status,
    created_at: NOW - 120,
    started_at: startedAt,
    completed_at: null,
    error: null,
    result: null,
    job_id: null,
    queue_name: 'lifecycle',
    attempt: 0,
  };
}

function plan(id: string, overrides: Partial<LifecyclePlan> = {}): LifecyclePlan {
  return {
    plan_id: id,
    device_id: `device-${id}`,
    job_class: 'provision',
    status: JobStatus.PENDING,
    created_at: NOW - 120,
    started_at: null,
    completed_at: null,
    error: null,
    metadata: {
      saga_name: 'provision',
      original_payload: { device_id: `device-${id}` },
    },
    steps: [step()],
    ...overrides,
  };
}

function manager(redis: RedisLike, encryptor?: RedisEncryptor): PlanManagerService {
  return new PlanManagerService(
    { redisKeyPrefix: PREFIX, defaultJobTtlSeconds: 7200 },
    redis,
    SILENT,
    encryptor,
  );
}

function seed(redis: MemoryRedis, value: LifecyclePlan): void {
  redis.values.set(`${PREFIX}:plan:${value.plan_id}`, JSON.stringify(serializeLifecyclePlan(value)));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('plan payload encryption', () => {
  it('encrypts payloads on persist and decrypts them on read', async () => {
    const redis = new MemoryRedis();
    const encryptor = new RedisEncryptor(Buffer.alloc(32, 1).toString('base64'), () => Buffer.alloc(12, 2));
    const service = manager(redis, encryptor);
    await service.createPlanFromSaga({
      planId: 'plan-1',
      deviceId: 'device-1',
      jobClass: 'provision',
      sagaDef: { name: 'provision', steps: [] },
      metadata: { saga_name: 'provision', original_payload: { secret: 'value' } },
    });
    const stored: Record<string, unknown> = JSON.parse(redis.values.get(`${PREFIX}:plan:plan-1`) ?? '{}');
    expect(stored.metadata).toHaveProperty('_enc_original_payload');
    expect(stored.metadata).not.toHaveProperty('original_payload');
    await expect(service.getPlan('plan-1')).resolves.toMatchObject({
      metadata: { original_payload: { secret: 'value' } },
    });
  });

  it('reads plaintext payloads without an encryptor', async () => {
    const redis = new MemoryRedis();
    seed(redis, plan('plain'));
    await expect(manager(redis).getPlan('plain')).resolves.toMatchObject({
      metadata: { original_payload: { device_id: 'device-plain' } },
    });
  });

  it('does not overwrite an existing plaintext payload during backfill', async () => {
    const redis = new MemoryRedis();
    seed(redis, plan('old'));
    await manager(redis).backfillOriginalPayload('old', { replacement: true });
    expect(redis.setCalls).toBe(0);
    expect(JSON.parse(redis.values.get(`${PREFIX}:plan:old`) ?? '{}')).toMatchObject({
      metadata: { original_payload: { device_id: 'device-old' } },
    });
  });
});

describe('resumable plan scan', () => {
  it('skips terminal plans', async () => {
    const redis = new MemoryRedis();
    seed(redis, plan('terminal', { status: JobStatus.COMPLETED }));
    await expect(manager(redis).scanResumablePlans({ graceSecs: 60, staleSecs: 1800, batchSize: 10 })).resolves.toEqual(
      [],
    );
  });

  it('skips plans without an original payload', async () => {
    const redis = new MemoryRedis();
    seed(redis, plan('missing', { metadata: { saga_name: 'provision' } }));
    await expect(manager(redis).scanResumablePlans({ graceSecs: 60, staleSecs: 1800, batchSize: 10 })).resolves.toEqual(
      [],
    );
  });

  it('skips plans inside the grace window', async () => {
    const redis = new MemoryRedis();
    seed(redis, plan('young', { created_at: NOW - 30 }));
    await expect(manager(redis).scanResumablePlans({ graceSecs: 60, staleSecs: 1800, batchSize: 10 })).resolves.toEqual(
      [],
    );
  });

  it('skips plans with a recent running step', async () => {
    const redis = new MemoryRedis();
    seed(redis, plan('running', { steps: [step(), step(JobStatus.RUNNING, NOW - 30)] }));
    await expect(manager(redis).scanResumablePlans({ graceSecs: 60, staleSecs: 1800, batchSize: 10 })).resolves.toEqual(
      [],
    );
  });

  it('returns plans with only a stale running step', async () => {
    const redis = new MemoryRedis();
    seed(redis, plan('stale', { status: JobStatus.RUNNING, steps: [step(JobStatus.RUNNING, NOW - 1801)] }));
    await expect(manager(redis).scanResumablePlans({ graceSecs: 60, staleSecs: 1800, batchSize: 10 })).resolves.toMatchObject([
      { planId: 'stale' },
    ]);
  });

  it('limits the result count to the batch size', async () => {
    const redis = new MemoryRedis();
    seed(redis, plan('one'));
    seed(redis, plan('two'));
    seed(redis, plan('three'));
    const results = await manager(redis).scanResumablePlans({ graceSecs: 60, staleSecs: 1800, batchSize: 2 });
    expect(results).toHaveLength(2);
  });

  it('returns the stored BullMQ job identifier', async () => {
    const redis = new MemoryRedis();
    seed(
      redis,
      plan('one', {
        metadata: {
          saga_name: 'provision',
          original_payload: { device_id: 'device-one' },
          bullmq_job_id: 'device-one-provision-one',
        },
      }),
    );
    const results = await manager(redis).scanResumablePlans({ graceSecs: 60, staleSecs: 1800, batchSize: 1 });
    expect(results[0].jobId).toBe('device-one-provision-one');
  });
});
