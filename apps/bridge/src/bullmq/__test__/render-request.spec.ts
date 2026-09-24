import { describe, expect, it } from 'vitest';

import {
  BullmqRenderRequestService,
  type RenderRequestQueue,
  type RenderRequestQueueAddOptions,
  type ResultsQueueProvider,
} from '../render-request.service';

const ZONE_ID = '00000000-0000-4000-8000-000000000001';
const REQUEST_ID_1 = '550e8400-e29b-41d4-a716-446655440001';
const REQUEST_ID_2 = '550e8400-e29b-41d4-a716-446655440002';
const REQUEST_ID_3 = '550e8400-e29b-41d4-a716-446655440003';
const REQUEST_ID_4 = '550e8400-e29b-41d4-a716-446655440004';
const RESULTS_QUEUE_NAME = 'inbox';

function asRecord(value: object): Record<string, unknown> {
  return { ...value };
}

interface AddCall {
  name: string;
  data: Record<string, unknown>;
  opts: RenderRequestQueueAddOptions;
}

class FakeQueue implements RenderRequestQueue {
  readonly name = RESULTS_QUEUE_NAME;
  readonly added: AddCall[] = [];

  constructor(private readonly onAdd?: () => void) {}

  async add(name: string, data: object, opts: RenderRequestQueueAddOptions): Promise<unknown> {
    this.added.push({ name, data: asRecord(data), opts });
    if (this.onAdd) this.onAdd();
    return {};
  }
}

function makeProvider(queue: RenderRequestQueue | null): {
  provider: ResultsQueueProvider;
  resetCalls: () => number;
} {
  let resetCalls = 0;
  const provider: ResultsQueueProvider = {
    getResultsQueue: async () => queue,
    resetSharedOpsStateOnConnectionError: async () => {
      resetCalls += 1;
      return false;
    },
  };
  return { provider, resetCalls: () => resetCalls };
}

function makeService(provider: ResultsQueueProvider): BullmqRenderRequestService {
  return new BullmqRenderRequestService(provider, { getZoneId: () => ZONE_ID }, { getZoneCryptoState: () => null });
}

describe('enqueueRenderRequest', () => {
  it('builds the payload and calls the queue', async () => {
    const queue = new FakeQueue();
    const { provider } = makeProvider(queue);

    const sent = await makeService(provider).enqueueRenderRequest({
      requestId: REQUEST_ID_1,
      domain: 'netplan',
      params: { phase: 'live' },
      bridgeId: 'bridge-1',
      entityId: 'dev-1',
      reason: 'missing',
    });

    expect(sent).toBe(true);
    expect(queue.added).toHaveLength(1);
    const { name, data, opts } = queue.added[0];
    expect(name).toBe('render.request');
    expect(opts.removeOnComplete).toEqual({ count: 0 });
    expect(opts.removeOnFail).toEqual({ count: 1000 });
    expect(data.request_id).toBe(REQUEST_ID_1);
    expect(data.zone_id).toBe(ZONE_ID);
    expect(data.bridge_id).toBe('bridge-1');
    expect(data.domain).toBe('netplan');
    expect(data.reason).toBe('missing');
    expect('entity_id' in data).toBe(false);
    expect(data.params).toEqual({ phase: 'live', entity_id: 'dev-1' });
  });

  it('omits optional fields when they are absent', async () => {
    const queue = new FakeQueue();
    const { provider } = makeProvider(queue);

    const sent = await makeService(provider).enqueueRenderRequest({
      requestId: REQUEST_ID_2,
      domain: 'device_record',
      bridgeId: 'bridge-1',
    });

    expect(sent).toBe(true);
    const { data } = queue.added[0];
    expect(data.domain).toBe('device_record');
    expect('reason' in data).toBe(false);
    expect('params' in data).toBe(false);
    expect('entity_id' in data).toBe(false);
  });

  it('returns false when the queue is unavailable', async () => {
    const { provider } = makeProvider(null);

    const sent = await makeService(provider).enqueueRenderRequest({
      requestId: REQUEST_ID_3,
      domain: 'netplan',
      params: { phase: 'live' },
      bridgeId: 'bridge-1',
      entityId: 'dev-1',
    });

    expect(sent).toBe(false);
  });

  it('returns false when queue.add raises', async () => {
    const queue = new FakeQueue(() => {
      throw new Error('redis down');
    });
    const { provider, resetCalls } = makeProvider(queue);

    const sent = await makeService(provider).enqueueRenderRequest({
      requestId: REQUEST_ID_4,
      domain: 'device_record',
      params: {},
      bridgeId: 'bridge-1',
      entityId: 'dev-1',
    });

    expect(sent).toBe(false);
    expect(resetCalls()).toBe(1);
  });

  it('enqueues the device_secret domain (lockstep with the hub enum)', async () => {
    const queue = new FakeQueue();
    const { provider } = makeProvider(queue);

    const sent = await makeService(provider).enqueueRenderRequest({
      requestId: REQUEST_ID_1,
      domain: 'device_secret',
      params: { purpose: 'BMC', kind: 'USER' },
      bridgeId: 'bridge-1',
      entityId: 'dev-1',
    });

    expect(sent).toBe(true);
    const { data } = queue.added[0];
    expect(data.domain).toBe('device_secret');
    expect(data.params).toEqual({ purpose: 'BMC', kind: 'USER', entity_id: 'dev-1' });
  });

  it('refuses an unknown domain before reaching the queue', async () => {
    const queue = new FakeQueue();
    const { provider } = makeProvider(queue);

    const sent = await makeService(provider).enqueueRenderRequest({
      requestId: REQUEST_ID_1,
      domain: 'some-future-domain',
      params: { any: 'shape' },
      bridgeId: 'bridge-1',
    });

    expect(sent).toBe(false);
    expect(queue.added).toHaveLength(0);
  });
});
