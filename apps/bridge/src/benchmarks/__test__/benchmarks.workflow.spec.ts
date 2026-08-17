import { describe, expect, it } from 'vitest';

import { stubSagaStep } from '../../saga-framework/__test__/stub-saga-steps';
import { buildBenchmarksSaga } from '../benchmarks.workflow';

const BENCHMARKS_SAGA = buildBenchmarksSaga({
  checkCcMode: stubSagaStep,
  runBenchmarks: stubSagaStep,
  reportResults: stubSagaStep,
});

describe('BENCHMARKS_SAGA', () => {
  it('exposes the expected saga name', () => {
    expect(BENCHMARKS_SAGA.name).toBe('benchmarks');
  });

  it('has at least one step', () => {
    expect(BENCHMARKS_SAGA.steps.length).toBeGreaterThan(0);
  });

  it('step order is stable', () => {
    const stepNames = BENCHMARKS_SAGA.steps.map((s) => s.name);
    expect(stepNames).toEqual(['check_cc_mode', 'run_benchmarks', 'report_results']);
  });

  it.each([
    ['check_cc_mode', 'Check Confidential Compute mode'],
    ['run_benchmarks', 'Run GPU burn-in and NCCL tests'],
    ['report_results', 'Report results to hub'],
  ])('step %s has operation description %s', (name, operation) => {
    const step = BENCHMARKS_SAGA.steps.find((s) => s.name === name);
    expect(step).toBeDefined();
    expect(step?.operation).toBe(operation);
  });

  it('run_benchmarks retries up to 2 attempts with self-rewind recovery', () => {
    const step = BENCHMARKS_SAGA.steps.find((s) => s.name === 'run_benchmarks');
    expect(step).toBeDefined();
    expect(step?.maxAttempts).toBe(2);
    const rewindTargets = (step?.recovery ?? []).map((r) => r.rewindTo);
    expect(rewindTargets).toEqual(['run_benchmarks']);
  });

  it('check_cc_mode and report_results have no recovery (default single attempt)', () => {
    for (const name of ['check_cc_mode', 'report_results']) {
      const step = BENCHMARKS_SAGA.steps.find((s) => s.name === name);
      expect(step?.recovery).toBeUndefined();
      expect(step?.maxAttempts).toBeUndefined();
    }
  });

  it('every step has an execute function', () => {
    for (const step of BENCHMARKS_SAGA.steps) {
      expect(typeof step.execute).toBe('function');
    }
  });
});
