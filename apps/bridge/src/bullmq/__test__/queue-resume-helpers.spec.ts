import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ZoneCryptoService } from '../../zone-crypto/zone-crypto.service.js';
import { resetBullmqConfigForTests } from '../bullmq.config.js';
import {
  BullmqQueueService,
  type BullmqQueue,
  type BullmqQueueFactory,
  type JobAddOptions,
  type SharedOpsClient,
} from '../queue.service.js';

class FakeQueue implements BullmqQueue {
  state: string | null = null;
  readonly order: string[] = [];
  readonly added: Array<{ data: Record<string, unknown>; opts: JobAddOptions }> = [];
  readonly queuedJobs: Array<{ id: string | null; data: unknown }> = [];
  removeError: Error | null = null;
  stateError: Error | null = null;

  async add(_name: string, data: Record<string, unknown>, opts: JobAddOptions): Promise<unknown> {
    this.order.push('add');
    this.added.push({ data, opts });
    return {};
  }

  async remove(): Promise<void> {
    this.order.push('remove');
    if (this.removeError !== null) throw this.removeError;
  }

  async getJobState(): Promise<string | null> {
    if (this.stateError !== null) throw this.stateError;
    return this.state;
  }

  async getQueuedJobs(): Promise<Array<{ id: string | null; data: unknown }>> {
    return this.queuedJobs;
  }

  async close(): Promise<void> {}
}

function service(queue: BullmqQueue, zoneCrypto?: ZoneCryptoService): BullmqQueueService {
  const client: SharedOpsClient = { aclose: async () => {} };
  const factory: BullmqQueueFactory = {
    createSharedOpsClient: () => client,
    createQueue: () => queue,
  };
  return new BullmqQueueService(factory, undefined, zoneCrypto);
}

function args() {
  return {
    planId: 'plan-1',
    sagaName: 'provision',
    payload: { device_id: 'device-1', deployment_os_token: 'secret-token' },
    deviceId: 'device-1',
  };
}

beforeEach(() => {
  resetBullmqConfigForTests();
});

afterEach(() => {
  new ZoneCryptoService().clear();
  vi.useRealTimers();
});

describe('queue resume helpers', () => {
  it.each(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'])(
    'reports %s jobs as present',
    async (state) => {
      const queue = new FakeQueue();
      queue.state = state;
      await expect(service(queue).jobExistsInQueue('job-1')).resolves.toBe(true);
    },
  );

  it.each(['completed', 'failed', null])('reports %s jobs as absent', async (state) => {
    const queue = new FakeQueue();
    queue.state = state;
    await expect(service(queue).jobExistsInQueue('job-1')).resolves.toBe(false);
  });

  it('reports a job as present when the state lookup fails', async () => {
    const queue = new FakeQueue();
    queue.stateError = new Error('connection reset');
    await expect(service(queue).jobExistsInQueue('job-1')).resolves.toBe(true);
  });

  it('finds a queued job by its plan identifier', async () => {
    const queue = new FakeQueue();
    queue.queuedJobs.push({ id: 'coalesced-job', data: { plan_id: 'plan-1' } });
    await expect(service(queue).jobExistsInQueue('missing-job', 'plan-1')).resolves.toBe(true);
  });

  it('removes the old job before it adds the replacement', async () => {
    const queue = new FakeQueue();
    await service(queue).enqueueSagaJob({ ...args(), removeExisting: true });
    expect(queue.order).toEqual(['remove', 'add']);
  });

  it('adds the replacement when the old job is absent', async () => {
    const queue = new FakeQueue();
    queue.removeError = new Error('Job not found');
    await expect(service(queue).enqueueSagaJob({ ...args(), removeExisting: true })).resolves.toBe(true);
    expect(queue.order).toEqual(['remove', 'add']);
  });

  it('encrypts and signs a bridge-local job when the zone is active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T02:00:00Z'));
    const queue = new FakeQueue();
    const zoneCrypto = new ZoneCryptoService();
    zoneCrypto.set({
      zonePriv: Buffer.alloc(32, 1),
      zonePub: Buffer.alloc(32, 2),
      hubPub: Buffer.alloc(32, 3),
      enrolledAt: Date.now(),
    });
    await service(queue, zoneCrypto).enqueueSagaJob({ ...args(), bridgeLocal: true });
    expect(queue.added[0].data).toMatchObject({
      __bridge_local: true,
      __bridge_local_ts: String(Math.floor(Date.now() / 1000)),
    });
    expect(queue.added[0].data.__bridge_local_sig).toMatch(/^[a-f0-9]{64}$/);
    expect(queue.added[0].data).not.toHaveProperty('payload');
    expect(JSON.stringify(queue.added[0].data)).not.toContain('secret-token');
    expect(queue.added[0].opts.jobId).toBe('device-1-provision-plan-1');
    vi.useRealTimers();
  });

  it('does not sign a bridge-local job when the zone is inactive', async () => {
    const queue = new FakeQueue();
    const zoneCrypto = new ZoneCryptoService();
    zoneCrypto.clear();
    await service(queue, zoneCrypto).enqueueSagaJob({ ...args(), bridgeLocal: true });
    expect(queue.added[0].data.__bridge_local).toBe(true);
    expect(queue.added[0].data).not.toHaveProperty('__bridge_local_ts');
    expect(queue.added[0].data).not.toHaveProperty('__bridge_local_sig');
  });
});
