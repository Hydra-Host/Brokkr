import { describe, expect, it } from 'vitest';

import { skipIfBrokkrLiveReady } from '../brokkr-live-skip';
import type { SagaContext } from '../saga.types';

function makeCtx(overrides: Partial<SagaContext> = {}): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'wait_for_brokkr_live',
    deviceId: 'device-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults: {},
    ...overrides,
  };
}

describe('skipIfBrokkrLiveReady', () => {
  it('returns null (do not skip) when the saga was rewound', () => {
    const ctx = makeCtx({ metadata: { rewound: true }, stepResults: { brokkr_live_check: { ready: true } } });
    expect(skipIfBrokkrLiveReady(ctx)).toBeNull();
  });

  it('returns null (do not skip) when deploy_os ran', () => {
    const ctx = makeCtx({ stepResults: { deploy_os: { done: true }, brokkr_live_check: { ready: true } } });
    expect(skipIfBrokkrLiveReady(ctx)).toBeNull();
  });

  it('returns a skip result when brokkr_live_check.ready is truthy', () => {
    const ctx = makeCtx({ stepResults: { brokkr_live_check: { ready: true } } });
    expect(skipIfBrokkrLiveReady(ctx)).toEqual({ skipped: true, reason: 'Brokkr Live already running' });
  });

  it('returns null when brokkr_live_check.ready is falsy', () => {
    const ctx = makeCtx({ stepResults: { brokkr_live_check: { ready: false } } });
    expect(skipIfBrokkrLiveReady(ctx)).toBeNull();
  });

  it('returns null when brokkr_live_check is absent', () => {
    expect(skipIfBrokkrLiveReady(makeCtx())).toBeNull();
  });

  it('throws when brokkr_live_check is a string (malformed internal state)', () => {
    const ctx = makeCtx({ stepResults: { brokkr_live_check: 'ready' } });
    expect(() => skipIfBrokkrLiveReady(ctx)).toThrow(TypeError);
  });

  it('throws when brokkr_live_check is an array (malformed internal state)', () => {
    const ctx = makeCtx({ stepResults: { brokkr_live_check: [] } });
    expect(() => skipIfBrokkrLiveReady(ctx)).toThrow(TypeError);
  });
});
