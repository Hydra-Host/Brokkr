import { describe, expect, it, vi } from 'vitest';

import type { SagaContext } from '../../saga-framework/saga.types';
import type { SyncVersionCache } from '../discovery-sync';
import { SyncStep } from '../steps/sync.step';

class FakeVersionCache implements SyncVersionCache {
  get(_key: string): Promise<string | null> {
    return Promise.resolve(null);
  }
  set(_key: string, _value: string): Promise<boolean> {
    return Promise.resolve(true);
  }
  delete(_key: string): Promise<number> {
    return Promise.resolve(0);
  }
}

function makeLogger() {
  return {
    info: vi.fn(async () => undefined),
    error: vi.fn(async () => undefined),
  };
}

function makeCtx(payload: Record<string, unknown> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'sync',
    deviceId: null,
    payload,
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
  };
}

describe('SyncStep.execute argument-order contract', () => {
  it('invokes the syncer with (cache, jobId, options) in that order', async () => {
    const cache = new FakeVersionCache();
    const logger = makeLogger();
    const syncFn = vi.fn(async () => undefined);
    const step = new SyncStep(cache, logger, syncFn);

    const result = await step.execute(makeCtx({ force: true }));

    expect(syncFn).toHaveBeenCalledTimes(1);
    expect(syncFn).toHaveBeenCalledWith(cache, 'job-1', { force: true });
    expect(result).toEqual({ success: true, sync_type: 'discovery', forced: true });
  });

  it('defaults to discovery sync_type and force=false', async () => {
    const cache = new FakeVersionCache();
    const logger = makeLogger();
    const syncFn = vi.fn(async () => undefined);
    const step = new SyncStep(cache, logger, syncFn);

    await step.execute(makeCtx());

    expect(syncFn).toHaveBeenCalledWith(cache, 'job-1', { force: false });
  });

  it('rejects an unknown sync_type without calling the syncer', async () => {
    const cache = new FakeVersionCache();
    const logger = makeLogger();
    const syncFn = vi.fn(async () => undefined);
    const step = new SyncStep(cache, logger, syncFn);

    const result = await step.execute(makeCtx({ sync_type: 'bogus' }));

    expect(result).toEqual({ success: false, error: 'Unknown sync type: bogus' });
    expect(syncFn).not.toHaveBeenCalled();
  });

  it('propagates and logs syncer failures', async () => {
    const cache = new FakeVersionCache();
    const logger = makeLogger();
    const syncFn = vi.fn(async () => {
      throw new Error('boom');
    });
    const step = new SyncStep(cache, logger, syncFn);

    await expect(step.execute(makeCtx())).rejects.toThrow('boom');
    expect(logger.error).toHaveBeenCalledWith('discovery sync failed: boom', { jobId: 'job-1' });
  });

  it('does not crash when a strict stub asserts exact argument shape', async () => {
    const cache = new FakeVersionCache();
    const logger = makeLogger();
    const strictSyncFn = vi.fn(async (c: SyncVersionCache, jobId: string, opts: { force?: boolean }) => {
      if (c !== cache) throw new Error(`expected cache as 1st arg, got ${typeof c}`);
      if (typeof jobId !== 'string') throw new Error(`expected jobId string as 2nd arg, got ${typeof jobId}`);
      if (typeof opts !== 'object' || opts === null) throw new Error('expected options object as 3rd arg');
    });
    const step = new SyncStep(cache, logger, strictSyncFn);

    await expect(step.execute(makeCtx({ force: false }))).resolves.toMatchObject({ success: true });
  });
});
