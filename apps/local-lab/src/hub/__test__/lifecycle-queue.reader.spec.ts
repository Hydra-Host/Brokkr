import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LifecycleQueueReaderService } from '../lifecycle-queue.reader';

const SAGA = { prefix: 'zone-1', name: 'lifecycle', kind: 'saga' as const };
const COLLECTION = { prefix: 'zone-1', name: 'collection', kind: 'saga' as const };
const RESULTS = { prefix: 'results', name: 'inbox', kind: 'results' as const };

const queueJob = (over: Record<string, unknown> = {}) => ({
  id: 'dev-1-provision-plan-1',
  name: 'saga.run',
  state: 'active',
  attemptsMade: 0,
  timestamp: 1,
  processedOn: null,
  finishedOn: null,
  delay: 0,
  failedReason: null,
  deviceId: 'dev-1',
  sagaName: 'provision',
  planId: 'plan-1',
  sealed: false,
  zoneId: 'zone-1',
  ...over,
});

let job: Record<string, unknown> | null;
let inventory: { prefix: string; name: string; kind: string }[];
let pages: Record<string, { jobs: Record<string, unknown>[]; discoveryCapped: boolean } | null>;
let listError: Error | null;

const makeReader = () =>
  new LifecycleQueueReaderService(
    { get: vi.fn(() => Promise.resolve({ job })) } as never,
    { inventory: vi.fn(() => Promise.resolve(inventory)) } as never,
    {
      list: vi.fn((prefix: string, name: string) => {
        if (listError) return Promise.reject(listError);
        return Promise.resolve(pages[`${prefix}:${name}`] ?? null);
      }),
    } as never,
  );

beforeEach(() => {
  job = { id: 'plan-1', deviceId: 'dev-1' };
  inventory = [SAGA, COLLECTION, RESULTS];
  pages = {
    'zone-1:lifecycle': { jobs: [queueJob()], discoveryCapped: false },
    'zone-1:collection': { jobs: [], discoveryCapped: false },
  };
  listError = null;
});

describe('LifecycleQueueReaderService', () => {
  it('matches a queue job by the plan id its own job id carries', async () => {
    const join = await makeReader().forJob('plan-1');

    expect(join.joinable).toBe(true);
    expect(join.matches).toHaveLength(1);
    expect(join.matches[0].job.id).toBe('dev-1-provision-plan-1');
    expect(join.matches[0].queue).toEqual(SAGA);
  });

  it('drops a queue job for another plan on the same device', async () => {
    pages['zone-1:lifecycle'] = {
      jobs: [queueJob(), queueJob({ id: 'dev-1-provision-plan-2', planId: 'plan-2' })],
      discoveryCapped: false,
    };

    const join = await makeReader().forJob('plan-1');

    expect(join.matches.map((match) => match.job.planId)).toEqual(['plan-1']);
  });

  it('searches only the saga queues, since the results inbox carries no device in its ids', async () => {
    const join = await makeReader().forJob('plan-1');

    expect(join.searchedQueues).toEqual([SAGA, COLLECTION]);
  });

  it('reports a job with no device as unjoinable rather than as having no queue jobs', async () => {
    job = { id: 'plan-1', deviceId: null };

    const join = await makeReader().forJob('plan-1');

    expect(join.joinable).toBe(false);
    expect(join.unjoinableReason).toContain('not scoped to a device');
    expect(join.matches).toEqual([]);
    expect(join.searchedQueues).toEqual([]);
  });

  it('reports a missing lifecycle job as unjoinable rather than joining nothing', async () => {
    job = null;

    const join = await makeReader().forJob('plan-1');

    expect(join.joinable).toBe(false);
    expect(join.unjoinableReason).toContain('no lifecycle job');
  });

  it('carries the scan cap forward, so a short match list cannot read as a complete one', async () => {
    pages['zone-1:collection'] = { jobs: [], discoveryCapped: true };

    const join = await makeReader().forJob('plan-1');

    expect(join.discoveryCapped).toBe(true);
    expect(join.matches).toHaveLength(1);
  });

  it('leaves the cap flag false when every queue answered in full', async () => {
    const join = await makeReader().forJob('plan-1');

    expect(join.discoveryCapped).toBe(false);
  });

  it('reports a queue that could not be read rather than presenting the rest as the whole answer', async () => {
    listError = new Error('redis down');

    const join = await makeReader().forJob('plan-1');

    expect(join.readError).toContain('redis down');
    expect(join.matches).toEqual([]);
  });

  it('keys the discovery on the device, which is what a saga job id actually embeds', async () => {
    const reader = makeReader();
    await reader.forJob('plan-1');

    const list = vi.mocked((reader as unknown as { queueJobs: { list: ReturnType<typeof vi.fn> } }).queueJobs.list);
    expect(list.mock.calls[0][2]).toMatchObject({ deviceId: 'dev-1' });
  });

  it('skips a queue the registry no longer resolves instead of counting it as searched', async () => {
    pages = { 'zone-1:lifecycle': { jobs: [queueJob()], discoveryCapped: false } };

    const join = await makeReader().forJob('plan-1');

    expect(join.searchedQueues).toEqual([SAGA]);
  });
});
