import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { runGpuBurn, runNccl } = vi.hoisted(() => ({ runGpuBurn: vi.fn(), runNccl: vi.fn() }));
vi.mock('../../benchmark/gpuBurn', () => ({ runGpuBurn }));
vi.mock('../../benchmark/nccl', () => ({ runNccl }));

import {
  clearOperationsForTests,
  getHandler,
  registerPluginOperation,
  type HandlerContext,
} from '../../../dispatch/registry';
import { registerRunTestSuite } from '.././runTestSuite';

const events: string[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function tracked(label: string, payload: Record<string, unknown>) {
  return async () => {
    events.push(`${label}:start`);
    await tick();
    events.push(`${label}:end`);
    return payload;
  };
}

function ctx(): HandlerContext {
  return {
    work_id: 'w',
    job_id: 't',
    signal: new AbortController().signal,
    reportProgress: () => {},
    emit: async () => {},
    resultDelivered: Promise.resolve(),
  };
}

beforeEach(() => {
  clearOperationsForTests();
  events.length = 0;
  runGpuBurn.mockImplementation(tracked('gpu_burn', { gpus: [] }));
  runNccl.mockImplementation(tracked('nccl', { ok: true }));
  registerPluginOperation('test.connectivity', z.unknown(), z.unknown(), tracked('connectivity', { connectivity: {} }));
  registerPluginOperation('test.performance', z.unknown(), z.unknown(), tracked('performance', { performance: {} }));
  registerPluginOperation('test.security', z.unknown(), z.unknown(), tracked('security', { security: {} }));
  registerPluginOperation('test.stress', z.unknown(), z.unknown(), tracked('stress', { stress: {} }));
  registerRunTestSuite();
});

describe('test.runTestSuite scheduling', () => {
  it('finishes the performance benchmark before any saturation workload starts', async () => {
    const handler = getHandler('test.runTestSuite');
    expect(handler).toBeDefined();

    await handler?.handler({ duration: '1', intensity: 'low' }, ctx());

    const performanceEnd = events.indexOf('performance:end');
    const stressStart = events.indexOf('stress:start');
    const gpuBurnStart = events.indexOf('gpu_burn:start');

    expect(performanceEnd).toBeGreaterThanOrEqual(0);
    expect(stressStart).toBeGreaterThan(performanceEnd);
    expect(gpuBurnStart).toBeGreaterThan(performanceEnd);
  });

  it('reports all six suites in the testing metadata', async () => {
    const handler = getHandler('test.runTestSuite');
    const result = (await handler?.handler({ duration: '1', intensity: 'low' }, ctx())) as {
      testing_metadata: { tests_total: number; tests_successful: number };
    };

    expect(result.testing_metadata.tests_total).toBe(6);
    expect(result.testing_metadata.tests_successful).toBe(6);
  });
});
