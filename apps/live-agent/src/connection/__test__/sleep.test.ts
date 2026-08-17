import { describe, expect, it } from 'vitest';

import { sleepWithAbort } from '../sleep';

import { getEventListeners } from 'node:events';

function abortListenerCount(signal: AbortSignal): number {
  return getEventListeners(signal as unknown as NodeJS.EventEmitter, 'abort').length;
}

describe('sleepWithAbort', () => {
  it('removes its abort listener after the timer fires (no leak across iterations)', async () => {
    const ctrl = new AbortController();
    for (let i = 0; i < 20; i++) {
      await sleepWithAbort(0, ctrl.signal);
      expect(abortListenerCount(ctrl.signal)).toBe(0);
    }
  });

  it('returns immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const start = Date.now();
    await sleepWithAbort(1_000, ctrl.signal);
    expect(Date.now() - start).toBeLessThan(50);
    expect(abortListenerCount(ctrl.signal)).toBe(0);
  });

  it('resolves on abort and removes the timer', async () => {
    const ctrl = new AbortController();
    const sleepPromise = sleepWithAbort(60_000, ctrl.signal);
    expect(abortListenerCount(ctrl.signal)).toBe(1);
    ctrl.abort();
    await sleepPromise;
    expect(abortListenerCount(ctrl.signal)).toBe(0);
  });
});
