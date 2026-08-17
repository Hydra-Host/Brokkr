import { describe, expect, it, vi } from 'vitest';

import { AutoCollectionService, cooldownKey } from '../../auto-collection/auto-collection.service';
import {
  collectionEnqueuedKey,
  SagaCooldownClearerService,
  type SagaCooldownCache,
  type SagaCooldownLogger,
} from '../saga-cooldown-clearer.service';

class FakeCache implements SagaCooldownCache {
  readonly calls: Array<{ key: string; jobId?: string }> = [];
  private readonly owner = new Map<string, string>();
  async delete(key: string, jobId?: string): Promise<number> {
    this.calls.push({ key, jobId });
    this.owner.delete(key);
    return 1;
  }
  async setNxOwned(key: string, value: string, _ttl: number, _jobId?: string): Promise<boolean> {
    const existing = this.owner.get(key);
    if (existing === undefined) {
      this.owner.set(key, value);
      return true;
    }
    return existing === value;
  }
}

const SILENT: SagaCooldownLogger = { warning: async () => {} };

function makeService(opts: {
  cache: SagaCooldownCache;
  autoCollection: AutoCollectionService;
  logger?: SagaCooldownLogger;
}): SagaCooldownClearerService {
  return new SagaCooldownClearerService(opts.cache, opts.autoCollection, opts.logger ?? SILENT);
}

describe('SagaCooldownClearerService', () => {
  it('awaits cache.delete with the cooldown key, then schedules enqueue fire-and-forget', async () => {
    const cache = new FakeCache();
    const enqueueResolvers: Array<() => void> = [];
    const enqueueCalls: Array<{ deviceId: string; jobId?: string }> = [];
    const maybeEnqueue = vi.fn(async (deviceId: string, opts: { jobId?: string }) => {
      enqueueCalls.push({ deviceId, jobId: opts.jobId });
      await new Promise<void>((resolve) => enqueueResolvers.push(resolve));
    });
    const autoCollection = {
      maybeEnqueueCollectionOnRegister: maybeEnqueue,
    } as unknown as AutoCollectionService;

    const service = makeService({ cache, autoCollection });

    await service.clearCooldownAndEnqueue('dev-42', 'plan-abc');

    expect(cache.calls).toEqual([{ key: cooldownKey('dev-42'), jobId: 'plan-abc' }]);
    expect(maybeEnqueue).toHaveBeenCalledTimes(1);
    expect(enqueueCalls).toEqual([{ deviceId: 'dev-42', jobId: 'plan-abc' }]);
    enqueueResolvers.forEach((r) => r());
  });

  it('does not block on the enqueue (returns before maybeEnqueue resolves)', async () => {
    const cache = new FakeCache();
    let enqueueResolved = false;
    let enqueueResolve!: () => void;
    const enqueuePromise = new Promise<void>((resolve) => {
      enqueueResolve = () => {
        enqueueResolved = true;
        resolve();
      };
    });
    const autoCollection = {
      maybeEnqueueCollectionOnRegister: async () => {
        await enqueuePromise;
      },
    } as unknown as AutoCollectionService;

    const service = makeService({ cache, autoCollection });

    await service.clearCooldownAndEnqueue('dev-1', 'plan-1');

    expect(enqueueResolved).toBe(false);
    enqueueResolve();
    await enqueuePromise;
  });

  it('enqueues at most once per job across retries (same jobId)', async () => {
    const cache = new FakeCache();
    const maybeEnqueue = vi.fn(async () => {});
    const autoCollection = {
      maybeEnqueueCollectionOnRegister: maybeEnqueue,
    } as unknown as AutoCollectionService;

    const service = makeService({ cache, autoCollection });

    await service.clearCooldownAndEnqueue('dev-7', 'plan-retry');
    await service.clearCooldownAndEnqueue('dev-7', 'plan-retry');

    expect(maybeEnqueue).toHaveBeenCalledTimes(1);
    expect(cache.calls).toEqual([
      { key: cooldownKey('dev-7'), jobId: 'plan-retry' },
      { key: cooldownKey('dev-7'), jobId: 'plan-retry' },
    ]);
  });

  it('still enqueues for a distinct job (different jobId)', async () => {
    const cache = new FakeCache();
    const maybeEnqueue = vi.fn(async () => {});
    const autoCollection = {
      maybeEnqueueCollectionOnRegister: maybeEnqueue,
    } as unknown as AutoCollectionService;

    const service = makeService({ cache, autoCollection });

    await service.clearCooldownAndEnqueue('dev-7', 'plan-a');
    await service.clearCooldownAndEnqueue('dev-7', 'plan-b');

    expect(maybeEnqueue).toHaveBeenCalledTimes(2);
  });

  it('logs and swallows enqueue rejections, then deletes the marker', async () => {
    const cache = new FakeCache();
    const warnings: Array<{ message: string; jobId?: string }> = [];
    const logger: SagaCooldownLogger = {
      warning: async (message, ctx) => {
        warnings.push({ message, jobId: ctx?.jobId });
      },
    };
    const autoCollection = {
      maybeEnqueueCollectionOnRegister: async () => {
        throw new Error('redis blew up');
      },
    } as unknown as AutoCollectionService;

    const service = makeService({ cache, autoCollection, logger });
    await service.clearCooldownAndEnqueue('dev-x', 'plan-x');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toMatch(/auto-collection schedule failed/);
    expect(warnings[0].message).toMatch(/redis blew up/);
    expect(warnings[0].jobId).toBe('plan-x');
    expect(cache.calls).toContainEqual({ key: collectionEnqueuedKey('plan-x'), jobId: 'plan-x' });
  });

  it('allows re-enqueue on retry when the previous enqueue failed', async () => {
    const cache = new FakeCache();
    let shouldFail = true;
    const maybeEnqueue = vi.fn(async () => {
      if (shouldFail) throw new Error('transient redis error');
    });
    const autoCollection = {
      maybeEnqueueCollectionOnRegister: maybeEnqueue,
    } as unknown as AutoCollectionService;

    const service = makeService({ cache, autoCollection });

    await service.clearCooldownAndEnqueue('dev-r', 'plan-r');
    await new Promise<void>((resolve) => setImmediate(resolve));

    shouldFail = false;
    await service.clearCooldownAndEnqueue('dev-r', 'plan-r');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(maybeEnqueue).toHaveBeenCalledTimes(2);
  });
});
