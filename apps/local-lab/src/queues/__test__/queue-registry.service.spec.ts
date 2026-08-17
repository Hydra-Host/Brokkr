import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueueRef, QueueSummary } from '../../contract';
import { QueueRegistryService } from '../queue-registry.service';

function makeReader() {
  return {
    scanMetaKeys: vi.fn((_match: string) => Promise.resolve<string[]>([])),
    queueExists: vi.fn((_prefix: string, _name: string) => Promise.resolve(false)),
    summary: vi.fn((ref: QueueRef) =>
      Promise.resolve<QueueSummary>({
        ...ref,
        counts: {
          wait: 1,
          active: 0,
          paused: 0,
          delayed: 0,
          prioritized: 0,
          'waiting-children': 0,
          completed: 0,
          failed: 0,
        },
        stalled: 0,
        paused: false,
        workers: 0,
        inFlight: 1,
        readError: null,
      }),
    ),
  };
}

function scanning(reader: ReturnType<typeof makeReader>, byMatch: Record<string, string[]>) {
  reader.scanMetaKeys.mockImplementation((match: string) => Promise.resolve(byMatch[match] ?? []));
}

let reader: ReturnType<typeof makeReader>;

function makeRegistry(zoneIds: string[]) {
  return new QueueRegistryService({ listZoneIds: vi.fn(() => Promise.resolve(zoneIds)) } as never, reader as never);
}

beforeEach(() => {
  reader = makeReader();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('QueueRegistryService.inventory', () => {
  it('unions the configured zones with both saga queue names', async () => {
    await expect(makeRegistry(['zone-a', 'zone-b']).inventory()).resolves.toEqual([
      { prefix: 'zone-a', name: 'collection', kind: 'saga' },
      { prefix: 'zone-a', name: 'lifecycle', kind: 'saga' },
      { prefix: 'zone-b', name: 'collection', kind: 'saga' },
      { prefix: 'zone-b', name: 'lifecycle', kind: 'saga' },
    ]);
  });

  it('discovers saga queues by scanning for their meta keys', async () => {
    scanning(reader, { '*:lifecycle:meta': ['zone-c:lifecycle:meta'] });
    await expect(makeRegistry([]).inventory()).resolves.toEqual([
      { prefix: 'zone-c', name: 'lifecycle', kind: 'saga' },
    ]);
    expect(reader.scanMetaKeys).toHaveBeenCalledWith('*:lifecycle:meta');
    expect(reader.scanMetaKeys).toHaveBeenCalledWith('*:collection:meta');
  });

  it('surfaces an orphan saga queue whose prefix is not a configured zone', async () => {
    scanning(reader, { '*:lifecycle:meta': ['bull:lifecycle:meta'], 'bull:*:meta': ['bull:lifecycle:meta'] });
    const inventory = await makeRegistry(['zone-a']).inventory();

    expect(inventory).toContainEqual({ prefix: 'bull', name: 'lifecycle', kind: 'saga' });
    expect(inventory.map((ref) => ref.prefix)).not.toContain('zone-b');
    expect(inventory.filter((ref) => ref.name === 'lifecycle' && ref.prefix === 'bull')).toHaveLength(1);
  });

  it('classifies a hub-prefixed queue that is not a saga queue as a hub queue', async () => {
    scanning(reader, { 'bull:*:meta': ['bull:device-status-effects:meta'] });
    await expect(makeRegistry([]).inventory()).resolves.toEqual([
      { prefix: 'bull', name: 'device-status-effects', kind: 'hub' },
    ]);
  });

  it('ignores a hub key that is not exactly bull:<name>:meta', async () => {
    scanning(reader, { 'bull:*:meta': ['bull:a:b:meta', 'bull::meta', 'bull:meta'] });
    await expect(makeRegistry([]).inventory()).resolves.toEqual([]);
  });

  it('includes the global results inbox only when its own meta key exists', async () => {
    reader.queueExists.mockResolvedValue(true);
    await expect(makeRegistry([]).inventory()).resolves.toEqual([
      { prefix: 'results', name: 'inbox', kind: 'results' },
    ]);
    expect(reader.queueExists).toHaveBeenCalledWith('results', 'inbox');
  });

  it('omits the results inbox when its meta key is absent', async () => {
    reader.queueExists.mockResolvedValue(false);
    await expect(makeRegistry([]).inventory()).resolves.toEqual([]);
  });

  it('orders saga queues before the results inbox before hub queues', async () => {
    reader.queueExists.mockResolvedValue(true);
    scanning(reader, { 'bull:*:meta': ['bull:device-status-effects:meta'] });
    const inventory = await makeRegistry(['zone-a']).inventory();

    expect(inventory.map((ref) => ref.kind)).toEqual(['saga', 'saga', 'results', 'hub']);
  });

  it('degrades to the configured zones when discovery scanning fails', async () => {
    reader.scanMetaKeys.mockRejectedValue(new Error('ECONNREFUSED'));
    reader.queueExists.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(makeRegistry(['zone-a']).inventory()).resolves.toEqual([
      { prefix: 'zone-a', name: 'collection', kind: 'saga' },
      { prefix: 'zone-a', name: 'lifecycle', kind: 'saga' },
    ]);
  });

  it('collapses concurrent discovery into a single scan pass', async () => {
    const registry = makeRegistry(['zone-a']);
    await Promise.all([registry.inventory(), registry.inventory(), registry.inventory()]);

    expect(reader.scanMetaKeys.mock.calls.map(([match]) => match)).toEqual([
      '*:lifecycle:meta',
      '*:collection:meta',
      'bull:*:meta',
    ]);
  });

  it('serves later polls from the cache and rediscovers only once the ttl lapses', async () => {
    vi.useFakeTimers();
    const registry = makeRegistry(['zone-a']);
    await registry.inventory();
    expect(reader.scanMetaKeys).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(2_000);
    await registry.inventory();
    vi.advanceTimersByTime(2_000);
    await registry.inventory();
    expect(reader.scanMetaKeys).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(15_000);
    await registry.inventory();
    expect(reader.scanMetaKeys).toHaveBeenCalledTimes(6);
  });
});

describe('QueueRegistryService.resolve', () => {
  it('resolves a discovered prefix/name to its ref', async () => {
    await expect(makeRegistry(['zone-a']).resolve('zone-a', 'lifecycle')).resolves.toEqual({
      prefix: 'zone-a',
      name: 'lifecycle',
      kind: 'saga',
    });
  });

  it('returns null for an unknown prefix and touches nothing with it', async () => {
    const registry = makeRegistry(['zone-a']);
    await expect(registry.resolve('attacker', 'lifecycle')).resolves.toBeNull();

    expect(reader.queueExists).not.toHaveBeenCalledWith('attacker', expect.anything());
    expect(reader.summary).not.toHaveBeenCalled();
  });

  it('returns null for a known prefix with an unknown queue name', async () => {
    await expect(makeRegistry(['zone-a']).resolve('zone-a', 'nonsense')).resolves.toBeNull();
    expect(reader.summary).not.toHaveBeenCalled();
  });
});

describe('QueueRegistryService.list', () => {
  it('reports one summary per discovered queue', async () => {
    const summaries = await makeRegistry(['zone-a']).list();

    expect(summaries.map((s) => `${s.prefix}:${s.name}`)).toEqual(['zone-a:collection', 'zone-a:lifecycle']);
    expect(summaries[0].inFlight).toBe(1);
    expect(reader.summary).toHaveBeenCalledTimes(2);
  });
});
