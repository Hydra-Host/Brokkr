import { beforeEach, describe, expect, it } from 'vitest';

import { resetBullmqConfigForTests } from '../bullmq.config';
import { makeJobId } from '../job-id';
import {
  BullmqQueueService,
  type BullmqQueue,
  type BullmqQueueFactory,
  type JobAddOptions,
  type SharedOpsClient,
} from '../queue.service';

interface AddCall {
  name: string;
  data: Record<string, unknown>;
  opts: JobAddOptions;
}

class FakeJob {
  removed = 0;

  constructor(private readonly state: string) {}

  async getState(): Promise<string> {
    return this.state;
  }

  async remove(): Promise<void> {
    this.removed += 1;
  }
}

class FakeQueue implements BullmqQueue {
  readonly added: AddCall[] = [];
  readonly jobs = new Map<string, FakeJob>();
  closed = 0;
  stateError?: Error;

  constructor(private readonly onAdd?: () => void) {}

  async add(name: string, data: Record<string, unknown>, opts: JobAddOptions): Promise<unknown> {
    this.added.push({ name, data, opts });
    if (this.onAdd) this.onAdd();
    return {};
  }

  async remove(jobId: string): Promise<void> {
    const job = this.jobs.get(jobId);
    if (job === undefined) throw new Error('Job not found');
    await job.remove();
    this.jobs.delete(jobId);
  }

  async getJobState(jobId: string): Promise<string | null> {
    if (this.stateError !== undefined) throw this.stateError;
    const job = this.jobs.get(jobId);
    return job === undefined ? null : job.getState();
  }

  async close(): Promise<void> {
    this.closed += 1;
  }
}

class FakeClient implements SharedOpsClient {
  closed = 0;
  async aclose(): Promise<void> {
    this.closed += 1;
  }
}

function makeFactory(queue: BullmqQueue): {
  factory: BullmqQueueFactory;
  client: FakeClient;
  createCount: () => number;
} {
  const client = new FakeClient();
  let createCount = 0;
  const factory: BullmqQueueFactory = {
    createSharedOpsClient: () => client,
    createQueue: () => {
      createCount += 1;
      return queue;
    },
  };
  return { factory, client, createCount: () => createCount };
}

function connError(): Error {
  const err = new Error('connection reset');
  (err as { code?: string }).code = 'ECONNRESET';
  return err;
}

beforeEach(() => {
  resetBullmqConfigForTests();
});

describe('makeJobId', () => {
  it('joins device id and suffix with a hyphen (colons in the id are preserved)', () => {
    expect(makeJobId(42, 'provision')).toBe('42-provision');
    expect(makeJobId('dev:123', 'wipe')).toBe('dev:123-wipe');
  });
});

describe('jobExistsInQueue', () => {
  it.each(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'])(
    'returns true for a live %s job',
    async (state) => {
      const queue = new FakeQueue();
      queue.jobs.set('42-provision', new FakeJob(state));
      const { factory } = makeFactory(queue);
      const service = new BullmqQueueService(factory);

      await expect(service.jobExistsInQueue('42-provision')).resolves.toBe(true);
    },
  );

  it.each(['completed', 'failed'])('returns false for a retained %s job', async (state) => {
    const queue = new FakeQueue();
    queue.jobs.set('42-provision', new FakeJob(state));
    const { factory } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    await expect(service.jobExistsInQueue('42-provision')).resolves.toBe(false);
  });

  it('returns false when the job id is free', async () => {
    const queue = new FakeQueue();
    const { factory } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    await expect(service.jobExistsInQueue('42-provision')).resolves.toBe(false);
  });

  it('returns true when the queue check fails', async () => {
    const queue = new FakeQueue();
    queue.stateError = new Error('Redis down');
    const { factory } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    await expect(service.jobExistsInQueue('42-provision')).resolves.toBe(true);
  });

  it('returns true when the queue state helper is unavailable', async () => {
    const queue: BullmqQueue = {
      add: async () => ({}),
      close: async () => undefined,
    };
    const { factory } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    await expect(service.jobExistsInQueue('42-provision')).resolves.toBe(true);
  });

  it('returns true when the lifecycle queue is unavailable', async () => {
    const service = new BullmqQueueService();

    await expect(service.jobExistsInQueue('42-provision')).resolves.toBe(true);
  });
});

describe('enqueueSagaJob', () => {
  it('returns false when the lifecycle queue is unavailable', async () => {
    const service = new BullmqQueueService();
    const result = await service.enqueueSagaJob({
      planId: 'plan-1',
      sagaName: 'provision',
      payload: { device_id: 42 },
      deviceId: 42,
    });
    expect(result).toBe(false);
  });

  it('adds a saga.run job with the plan jobId and snake_case payload', async () => {
    const queue = new FakeQueue();
    const { factory } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    const result = await service.enqueueSagaJob({
      planId: 'plan-2',
      sagaName: 'provision',
      payload: { device_id: 2 },
      deviceId: 2,
    });

    expect(result).toBe(true);
    expect(queue.added).toHaveLength(1);
    const [call] = queue.added;
    expect(call.name).toBe('saga.run');
    expect(call.data.plan_id).toBe('plan-2');
    expect(call.data.saga_name).toBe('provision');
    expect(call.data.device_id).toBe('2');
    expect(call.opts.jobId).toBe('2-provision-plan-2');
    expect(call.opts.attempts).toBe(2);
    expect(call.opts.removeOnComplete.count).toBe(100);
    expect(call.opts.removeOnFail.count).toBe(500);
  });

  it.each(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'])(
    'returns true without adding when the existing job is %s',
    async (state) => {
      const queue = new FakeQueue();
      const existing = new FakeJob(state);
      queue.jobs.set('2-provision-plan-2', existing);
      const { factory } = makeFactory(queue);
      const service = new BullmqQueueService(factory);

      const result = await service.enqueueSagaJob({
        planId: 'plan-2',
        sagaName: 'provision',
        payload: { device_id: 2 },
        deviceId: 2,
      });

      expect(result).toBe(true);
      expect(existing.removed).toBe(0);
      expect(queue.added).toHaveLength(0);
    },
  );

  it('removes an existing inactive job before adding', async () => {
    const queue = new FakeQueue();
    const existing = new FakeJob('completed');
    queue.jobs.set('2-provision-plan-2', existing);
    const { factory } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    const result = await service.enqueueSagaJob({
      planId: 'plan-2',
      sagaName: 'provision',
      payload: { device_id: 2 },
      deviceId: 2,
    });

    expect(result).toBe(true);
    expect(existing.removed).toBe(1);
    expect(queue.added).toHaveLength(1);
  });

  it('uses the aggressive retention tier for ephemeral sagas', async () => {
    const queue = new FakeQueue();
    const { factory } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    await service.enqueueSagaJob({
      planId: 'plan-hc',
      sagaName: 'device_health_check',
      payload: {},
      deviceId: 7,
    });

    const [call] = queue.added;
    expect(call.opts.removeOnComplete.count).toBe(3);
    expect(call.opts.removeOnFail.count).toBe(10);
  });

  it('does NOT reset the shared queue on a non-connection failure', async () => {
    const queue = new FakeQueue(() => {
      throw new Error('Redis down');
    });
    const { factory, client, createCount } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    const result = await service.enqueueSagaJob({
      planId: 'plan-fail',
      sagaName: 'deprovision',
      payload: { device_id: 99 },
      deviceId: 99,
    });

    expect(result).toBe(false);
    await service.getLifecycleQueue();
    expect(createCount()).toBe(1);
    expect(client.closed).toBe(0);
  });

  it('resets the shared queue + client on a connection failure', async () => {
    const queue = new FakeQueue(() => {
      throw connError();
    });
    const { factory, client, createCount } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    const result = await service.enqueueSagaJob({
      planId: 'plan-fail',
      sagaName: 'deprovision',
      payload: { device_id: 99 },
      deviceId: 99,
    });

    expect(result).toBe(false);
    expect(queue.closed).toBe(1);
    expect(client.closed).toBe(1);
    await service.getLifecycleQueue();
    expect(createCount()).toBe(2);
  });
});

describe('enqueueCollectionJob', () => {
  it('adds a collection.run job with stringified device id and dedup jobId', async () => {
    const queue = new FakeQueue();
    const { factory } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    const result = await service.enqueueCollectionJob({ deviceId: 42, jobId: 'test-job' });

    expect(result).toBe(true);
    expect(queue.added).toHaveLength(1);
    const [call] = queue.added;
    expect(call.name).toBe('collection.run');
    expect(call.data.device_id).toBe('42');
    expect(call.data.job_id).toBe('test-job');
    expect(call.opts.jobId).toBe('42-inventory_collection');
    expect(call.opts.attempts).toBe(2);
  });

  it('falls back to the generated plan id when no jobId is given', async () => {
    const queue = new FakeQueue();
    const { factory } = makeFactory(queue);
    const service = new BullmqQueueService(factory);

    await service.enqueueCollectionJob({ deviceId: 5 });

    const [call] = queue.added;
    expect(call.data.job_id).toBe(call.data.plan_id);
    expect(typeof call.data.plan_id).toBe('string');
  });

  it('returns false when the collection queue is unavailable', async () => {
    const service = new BullmqQueueService();
    const result = await service.enqueueCollectionJob({ deviceId: 42, jobId: 'test-job' });
    expect(result).toBe(false);
  });
});
