import { describe, expect, it } from 'vitest';

import type { LifecyclePlan, LifecyclePlanStep } from '../plan.types';
import { collectStepResults, isTruthyResult } from '../saga-runner.service';
import { JobStatus } from '../state.types';

function completedStep(stepName: string, result: unknown): LifecyclePlanStep {
  return {
    step_name: stepName,
    operation: stepName,
    status: JobStatus.COMPLETED,
    created_at: 0,
    started_at: 0,
    completed_at: 0,
    error: null,
    result: result as LifecyclePlanStep['result'],
    job_id: null,
    queue_name: null,
    attempt: 0,
  };
}

function planWith(steps: LifecyclePlanStep[]): LifecyclePlan {
  return {
    plan_id: 'plan-1',
    device_id: 'dev-1',
    job_class: 'test',
    status: JobStatus.RUNNING,
    created_at: 0,
    started_at: 0,
    completed_at: null,
    error: null,
    metadata: {},
    steps,
  };
}

describe('isTruthyResult (Python-truthiness on heterogeneous step results)', () => {
  it('treats the Python-falsy set as "no result"', () => {
    for (const value of [null, undefined, false, 0, 0n, '', NaN, [], {}, new Map(), new Set()]) {
      expect(isTruthyResult(value)).toBe(false);
    }
  });

  it('treats non-empty / non-zero results as present', () => {
    for (const value of [true, 1, 'a', '0', [0], { a: 1 }, new Map([['a', 1]]), new Set([0])]) {
      expect(isTruthyResult(value)).toBe(true);
    }
  });
});

describe('collectStepResults', () => {
  it('omits completed steps whose result is Python-falsy (incl. empty []/{})', () => {
    const plan = planWith([
      completedStep('empty_obj', {}),
      completedStep('empty_arr', []),
      completedStep('empty_str', ''),
      completedStep('kept_obj', { ok: true }),
      completedStep('kept_arr', [1]),
    ]);
    expect(collectStepResults(plan)).toEqual({
      kept_obj: { ok: true },
      kept_arr: [1],
    });
  });
});
