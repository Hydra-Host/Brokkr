import { describe, expect, it, vi } from 'vitest';

import {
  AgentNotConnected,
  AgentNotResponsive,
  DispatchFailed,
  DispatchTimeout,
} from '../../agent/dispatch/grpc.exceptions';
import type { SagaContext } from '../../saga-framework/saga.types';
import { CollectHardwareStep } from '../steps/collect-hardware.step';

function makeLogger() {
  return {
    info: vi.fn(async () => undefined),
    warning: vi.fn(async () => undefined),
  };
}

function makeRegistry(isConnected: boolean) {
  return { isConnected: vi.fn(() => isConnected) };
}

function makeResults() {
  return {
    clearCollectionData: vi.fn(async () => true),
    getCollectionFieldCount: vi.fn(() => null),
  };
}

function makeCtx(stepResults: Record<string, unknown> = { wait_for_brokkr_live: { os_ready: true } }): SagaContext {
  return {
    planId: 'plan-1',
    stepName: 'collect_hardware',
    deviceId: 'device-1',
    payload: {},
    jobId: 'job-1',
    attempt: 1,
    metadata: {},
    stepResults,
  };
}

describe('CollectHardwareStep.execute', () => {
  describe('deviceReady gate', () => {
    it('skips collection when brokkr_live_check is present but reports neither ready signal', async () => {
      const dispatcher = { dispatchTyped: vi.fn(async () => ({})) };
      const registry = makeRegistry(true);
      const results = makeResults();
      const logger = makeLogger();
      const step = new CollectHardwareStep(dispatcher, registry, results, logger);

      const result = await step.execute(makeCtx({ brokkr_live_check: { ready: false } }));

      expect(result).toEqual({ collected: false, reason: 'device not reachable' });
      expect(dispatcher.dispatchTyped).not.toHaveBeenCalled();
      expect(registry.isConnected).not.toHaveBeenCalled();
    });

    it('skips collection when only wait_for_brokkr_live is present and reports not ready (checkResult == null)', async () => {
      const dispatcher = { dispatchTyped: vi.fn(async () => ({ successes: 1, failures: 0 })) };
      const registry = makeRegistry(true);
      const results = makeResults();
      const logger = makeLogger();
      const step = new CollectHardwareStep(dispatcher, registry, results, logger);

      const result = await step.execute(makeCtx({ wait_for_brokkr_live: { os_ready: false } }));

      expect(result).toEqual({ collected: false, reason: 'device not reachable' });
      expect(dispatcher.dispatchTyped).not.toHaveBeenCalled();
      expect(registry.isConnected).not.toHaveBeenCalled();
    });

    it('falls through to collection when wait_for_brokkr_live reports os_ready (checkResult == null)', async () => {
      const dispatcher = { dispatchTyped: vi.fn(async () => ({ successes: 1, failures: 0 })) };
      const registry = makeRegistry(true);
      const results = makeResults();
      const logger = makeLogger();
      const step = new CollectHardwareStep(dispatcher, registry, results, logger);

      const result = await step.execute(makeCtx({ wait_for_brokkr_live: { os_ready: true } }));

      expect(result).toMatchObject({ collected: true });
      expect(dispatcher.dispatchTyped).toHaveBeenCalledTimes(1);
    });
  });

  it('throws when the device has no active agent gRPC session', async () => {
    const dispatcher = { dispatchTyped: vi.fn(async () => ({})) };
    const registry = makeRegistry(false);
    const results = makeResults();
    const logger = makeLogger();
    const step = new CollectHardwareStep(dispatcher, registry, results, logger);

    const result = await step.execute(makeCtx());

    expect(result).toEqual({
      collected: false,
      error: 'Device device-1 has no active agent gRPC session; agent may not be deployed yet',
    });
    expect(dispatcher.dispatchTyped).not.toHaveBeenCalled();
  });

  it('tallies agent successes/failures and clears collection data on the happy path', async () => {
    const summary = { successes: 3, failures: 1, collectors_run: [], total_duration_ms: 0 };
    const dispatcher = { dispatchTyped: vi.fn(async () => summary) };
    const registry = makeRegistry(true);
    const results = makeResults();
    const logger = makeLogger();
    const step = new CollectHardwareStep(dispatcher, registry, results, logger);

    const result = await step.execute(makeCtx());

    expect(result).toEqual({
      collected: true,
      metadata: {
        collectors_total: 4,
        collectors_successful: 3,
        collectors_failed: 1,
        agent_summary: summary,
      },
    });
    expect(results.clearCollectionData).toHaveBeenCalledWith('device-1');
  });

  it('re-raises AgentNotConnected instead of swallowing it', async () => {
    const dispatcher = {
      dispatchTyped: vi.fn(async () => {
        throw new AgentNotConnected('device-1');
      }),
    };
    const step = new CollectHardwareStep(dispatcher, makeRegistry(true), makeResults(), makeLogger());

    await expect(step.execute(makeCtx())).rejects.toBeInstanceOf(AgentNotConnected);
  });

  it('re-raises AgentNotResponsive instead of swallowing it', async () => {
    const dispatcher = {
      dispatchTyped: vi.fn(async () => {
        throw new AgentNotResponsive('device-1', 5);
      }),
    };
    const step = new CollectHardwareStep(dispatcher, makeRegistry(true), makeResults(), makeLogger());

    await expect(step.execute(makeCtx())).rejects.toBeInstanceOf(AgentNotResponsive);
  });

  it('swallows a wrapped DispatchTimeout as a non-fatal result', async () => {
    const dispatcher = {
      dispatchTyped: vi.fn(async () => {
        throw new DispatchTimeout('took too long');
      }),
    };
    const results = makeResults();
    const step = new CollectHardwareStep(dispatcher, makeRegistry(true), results, makeLogger());

    const result = await step.execute(makeCtx());

    expect(result).toEqual({
      collected: false,
      error: 'Collection timed out for device device-1: took too long',
    });
  });

  it('swallows a wrapped DispatchFailed as a non-fatal result', async () => {
    const dispatcher = {
      dispatchTyped: vi.fn(async () => {
        throw new DispatchFailed('UNAVAILABLE', 'agent gone');
      }),
    };
    const step = new CollectHardwareStep(dispatcher, makeRegistry(true), makeResults(), makeLogger());

    const result = await step.execute(makeCtx());

    expect(result).toEqual({
      collected: false,
      error: 'Collection dispatch failed for device device-1: UNAVAILABLE: agent gone',
    });
  });
});
