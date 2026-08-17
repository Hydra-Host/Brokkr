import { describe, expect, it } from 'vitest';

import { BullmqHandlerRegistrar } from '../bullmq.module.js';
import { JOB_NAME } from '../bullmq.types.js';
import { CollectionJobHandler } from '../collection.handler.js';
import { DiagnosticsJobHandler } from '../diagnostics.handler.js';
import type { JobHandler } from '../handlers.service.js';
import { BullmqRegistryService, getQueueCounts, type CountableQueue, type QueueSource } from '../registry.service.js';
import { SagaJobHandler } from '../saga.handler.js';
import { TestingJobHandler } from '../testing.handler.js';

function makeQueue(counts: Record<string, number>): CountableQueue {
  return {
    async getJobCounts(...states: string[]): Promise<Record<string, number>> {
      const out: Record<string, number> = {};
      for (const state of states) {
        out[state] = counts[state] ?? 0;
      }
      return out;
    },
  };
}

function makeErrorQueue(message: string): CountableQueue {
  return {
    async getJobCounts(): Promise<Record<string, number>> {
      throw new Error(message);
    },
  };
}

describe('getQueueCounts', () => {
  it('returns the wait→queued remapped counts', async () => {
    const counts = await getQueueCounts(makeQueue({ wait: 5, active: 2, completed: 100, failed: 3, delayed: 1 }));
    expect(counts).toEqual({
      queued: 5,
      active: 2,
      completed: 100,
      failed: 3,
      delayed: 1,
    });
  });

  it('returns all zeros when the queue throws', async () => {
    const counts = await getQueueCounts(makeErrorQueue('Redis down'));
    expect(counts).toEqual({
      queued: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    });
  });
});

describe('BullmqRegistryService.collectQueueStates', () => {
  it('collects state for all three queues with the queue_mode passthrough', async () => {
    const queue = makeQueue({ wait: 1, active: 0, completed: 10, failed: 0, delayed: 0 });
    const sources: QueueSource[] = [
      { label: 'lifecycle', getQueue: async () => queue },
      { label: 'collection', getQueue: async () => queue },
      { label: 'results', getQueue: async () => queue },
    ];

    const service = new BullmqRegistryService();
    const result = await service.collectQueueStates(sources, { queueMode: 'device' });

    expect(result.backend).toBe('redis');
    expect(result.queue_mode).toBe('device');
    expect(result.queues).toHaveLength(3);
    expect(result.queues[0]).toEqual({
      queue_name: 'lifecycle',
      queued: 1,
      active: 0,
      completed: 10,
      failed: 0,
      delayed: 0,
    });
    expect(result.queues[1].queue_name).toBe('collection');
    expect(result.queues[2].queue_name).toBe('results');
  });

  it('skips sources whose getQueue resolves to null', async () => {
    const queue = makeQueue({ wait: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
    const sources: QueueSource[] = [
      { label: 'lifecycle', getQueue: async () => queue },
      { label: 'collection', getQueue: async () => null },
      { label: 'results', getQueue: async () => queue },
    ];

    const service = new BullmqRegistryService();
    const result = await service.collectQueueStates(sources, { queueMode: 'device' });

    expect(result.queues.map((q) => q.queue_name)).toEqual(['lifecycle', 'results']);
  });

  it('captures per-source failures as error entries instead of aborting the whole report', async () => {
    const queue = makeQueue({ wait: 4, active: 1, completed: 2, failed: 0, delayed: 0 });
    const sources: QueueSource[] = [
      { label: 'lifecycle', getQueue: async () => queue },
      {
        label: 'collection',
        getQueue: async () => {
          throw new Error('connection refused');
        },
      },
      { label: 'results', getQueue: async () => queue },
    ];

    const service = new BullmqRegistryService();
    const result = await service.collectQueueStates(sources, { queueMode: 'device' });

    expect(result.queues).toHaveLength(3);
    expect(result.queues[1]).toEqual({
      queue_name: 'collection',
      error: 'connection refused',
    });
    expect(result.queues[0].queue_name).toBe('lifecycle');
    expect(result.queues[2].queue_name).toBe('results');
  });
});

describe('BullmqRegistryService handler dispatch dict', () => {
  it('register/getHandler round-trips job-name → handler', () => {
    const service = new BullmqRegistryService();
    const saga: JobHandler = async () => ({ ok: 'saga' });
    const collection: JobHandler = async () => ({ ok: 'coll' });
    service.register(JOB_NAME.SAGA_RUN, saga);
    service.register(JOB_NAME.COLLECTION_RUN, collection);

    expect(service.getHandler(JOB_NAME.SAGA_RUN)).toBe(saga);
    expect(service.getHandler(JOB_NAME.COLLECTION_RUN)).toBe(collection);
    expect(service.getHandler('unknown')).toBeUndefined();
    expect(Object.keys(service.getHandlers())).toEqual([JOB_NAME.SAGA_RUN, JOB_NAME.COLLECTION_RUN]);
  });
});

describe('BullmqHandlerRegistrar', () => {
  it('registers all 4 handlers (saga + collection + diagnostics + testing)', () => {
    const registry = new BullmqRegistryService();
    const saga = { handle: (async () => ({ ok: 'saga' })) as JobHandler } as SagaJobHandler;
    const collection = {
      handle: (async () => ({ ok: 'coll' })) as JobHandler,
    } as CollectionJobHandler;
    const diagnostics = {
      handle: (async () => ({ ok: 'diag' })) as JobHandler,
    } as DiagnosticsJobHandler;
    const testing = {
      handle: (async () => ({ ok: 'test' })) as JobHandler,
    } as TestingJobHandler;

    new BullmqHandlerRegistrar(registry, saga, collection, diagnostics, testing);

    expect(registry.getHandler(JOB_NAME.SAGA_RUN)).toBe(saga.handle);
    expect(registry.getHandler(JOB_NAME.COLLECTION_RUN)).toBe(collection.handle);
    expect(registry.getHandler(JOB_NAME.DIAGNOSTICS_RUN)).toBe(diagnostics.handle);
    expect(registry.getHandler(JOB_NAME.TESTING_RUN)).toBe(testing.handle);
    expect(Object.keys(registry.getHandlers()).sort()).toEqual(
      [JOB_NAME.COLLECTION_RUN, JOB_NAME.DIAGNOSTICS_RUN, JOB_NAME.SAGA_RUN, JOB_NAME.TESTING_RUN].sort(),
    );
  });

  it('skips handlers that are absent (Optional injection)', () => {
    const registry = new BullmqRegistryService();
    new BullmqHandlerRegistrar(registry);
    expect(Object.keys(registry.getHandlers())).toEqual([]);
  });
});
