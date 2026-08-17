import { describe, expect, it } from 'vitest';

import { testingTimeoutS } from '../testing.handler';

const PHASE_MULTIPLE = 7;
const NCCL_WORST_CASE_RUNTIME_S = 3600;

function phasedSuiteWorstCaseS(durationMinutes: number): number {
  return durationMinutes * 60 * PHASE_MULTIPLE;
}

describe('testingTimeoutS', () => {
  it('covers the phased suite worst-case at the default 30m duration', () => {
    expect(testingTimeoutS('30m')).toBeGreaterThan(phasedSuiteWorstCaseS(30));
  });

  it('scales with longer durations so a 1h run still fits', () => {
    expect(testingTimeoutS('1h')).toBeGreaterThan(phasedSuiteWorstCaseS(60));
  });

  it('is strictly increasing in duration', () => {
    expect(testingTimeoutS('1h')).toBeGreaterThan(testingTimeoutS('30m'));
  });

  it('never drops below the fixed NCCL worst-case runtime for short durations', () => {
    expect(testingTimeoutS('5m')).toBeGreaterThan(NCCL_WORST_CASE_RUNTIME_S);
    expect(testingTimeoutS('1m')).toBeGreaterThan(NCCL_WORST_CASE_RUNTIME_S);
  });

  it('falls back to the 30m budget for a missing or non-string duration', () => {
    expect(testingTimeoutS(undefined)).toBe(testingTimeoutS('30m'));
    expect(testingTimeoutS('garbage')).toBe(testingTimeoutS('30m'));
  });
});
