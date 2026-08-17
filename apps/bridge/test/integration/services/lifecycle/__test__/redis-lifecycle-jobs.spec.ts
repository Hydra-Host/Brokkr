import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetBullmqConfigForTests } from '../../../../../src/bullmq/bullmq.config';
import { makeJobId } from '../../../../../src/bullmq/job-id';
import {
  BullmqQueueService,
  type BullmqQueue,
  type BullmqQueueFactory,
  type JobAddOptions,
  type QueueCreateOptions,
  type SharedOpsClient,
} from '../../../../../src/bullmq/queue.service';
import { PlanManagerService, type RedisLike } from '../../../../../src/saga-framework/plan-manager.service';
import type { SagaDef } from '../../../../../src/saga-framework/saga.types';
import { JobStatus } from '../../../../../src/saga-framework/state.types';

class InMemoryRedis implements RedisLike {
  private readonly store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string, _opts?: { ex?: number }): Promise<'OK'> {
    this.store.set(key, value);
    return 'OK';
  }

  async scan(pattern: string): Promise<string[]> {
    const prefix = pattern.slice(0, -1);
    return [...this.store.keys()].filter((key) => key.startsWith(prefix));
  }
}

interface RecordedJobAdd {
  queueName: string;
  jobName: string;
  data: Record<string, unknown>;
  opts: JobAddOptions;
}

class FakeBullmqQueue implements BullmqQueue {
  constructor(
    private readonly queueName: string,
    private readonly sink: RecordedJobAdd[],
  ) {}

  async add(name: string, data: Record<string, unknown>, opts: JobAddOptions): Promise<unknown> {
    this.sink.push({ queueName: this.queueName, jobName: name, data, opts });
    return { id: opts.jobId, name };
  }

  async remove(): Promise<void> {}

  async getJobState(): Promise<string | null> {
    return null;
  }

  async close(): Promise<void> {}
}

class FakeSharedOpsClient implements SharedOpsClient {
  async aclose(): Promise<void> {}
}

class RecordingBullmqFactory implements BullmqQueueFactory {
  readonly adds: RecordedJobAdd[] = [];

  createSharedOpsClient(): SharedOpsClient {
    return new FakeSharedOpsClient();
  }

  createQueue(queueName: string, _options: QueueCreateOptions): BullmqQueue {
    return new FakeBullmqQueue(queueName, this.adds);
  }
}

function buildTwoStepSaga(): SagaDef {
  return {
    name: 'lifecycle',
    steps: [
      { name: 'step_one', operation: 'First step', execute: async () => null },
      { name: 'step_two', operation: 'Second step', execute: async () => null },
    ],
  };
}

describe('integration/services/lifecycle: redis-backed lifecycle jobs', () => {
  let redis: InMemoryRedis;

  beforeEach(() => {
    redis = new InMemoryRedis();
    resetBullmqConfigForTests();
  });

  afterEach(() => {
    resetBullmqConfigForTests();
  });

  it('lifecycle plan persists in Redis (step transitions survive a fresh manager)', async () => {
    const planId = `plan-redis-${Math.random().toString(16).slice(2, 10)}`;

    const manager = new PlanManagerService({ redisKeyPrefix: 'bridge:test', defaultJobTtlSeconds: 3600 }, redis);
    await manager.start();

    await manager.createPlanFromSaga({
      planId,
      deviceId: 101,
      jobClass: 'lifecycle',
      sagaDef: buildTwoStepSaga(),
      queueName: 'lifecycle:lifecycle:101',
    });

    await manager.updateStepStatus({
      planId,
      stepName: 'step_one',
      status: JobStatus.COMPLETED,
      result: { ok: true },
    });

    const restarted = new PlanManagerService({ redisKeyPrefix: 'bridge:test', defaultJobTtlSeconds: 3600 }, redis);
    await restarted.start();
    const loaded = await restarted.getPlan(planId);

    expect(loaded).not.toBeNull();
    expect(loaded?.plan_id).toBe(planId);
    expect(loaded?.steps.length).toBe(2);
    expect(loaded?.steps[0]?.status).toBe(JobStatus.COMPLETED);
    expect(loaded?.steps[0]?.result).toEqual({ ok: true });
    expect(loaded?.steps[1]?.status).toBe(JobStatus.PENDING);
  });

  it('bullmq enqueue writes saga job to the lifecycle queue', async () => {
    const factory = new RecordingBullmqFactory();
    const service = new BullmqQueueService(factory);

    const planId = `bullmq-redis-${Math.random().toString(16).slice(2, 10)}`;
    const deviceId = 999;
    const sagaName = 'deprovision';

    const queued = await service.enqueueSagaJob({
      planId,
      sagaName,
      payload: { device_id: deviceId },
      deviceId,
    });
    expect(queued).toBe(true);

    expect(factory.adds.length).toBe(1);
    const recorded = factory.adds[0]!;
    expect(recorded.queueName).toBe('lifecycle');
    expect(recorded.data).toEqual({
      plan_id: planId,
      saga_name: sagaName,
      payload: { device_id: deviceId },
      device_id: String(deviceId),
    });
    expect(recorded.opts.jobId).toBe(makeJobId(deviceId, `${sagaName}-${planId}`));
  });
});
