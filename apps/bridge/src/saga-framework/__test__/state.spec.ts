import { describe, expect, it } from 'vitest';

import { coerceStatus, transitionTimestamps } from '../state.service';
import { JobStatus, TERMINAL_STATUSES } from '../state.types';

describe('saga-framework state exports', () => {
  it('JobStatus enum is exported with the expected string values', () => {
    expect(JobStatus.PENDING).toBe('pending');
    expect(JobStatus.RUNNING).toBe('running');
    expect(JobStatus.BLOCKED).toBe('blocked');
    expect(JobStatus.COMPLETED).toBe('complete');
    expect(JobStatus.FAILED).toBe('failed');
    expect(JobStatus.CANCELLED).toBe('cancelled');
  });

  it('TERMINAL_STATUSES covers the three terminal job states', () => {
    expect(TERMINAL_STATUSES.has(JobStatus.COMPLETED)).toBe(true);
    expect(TERMINAL_STATUSES.has(JobStatus.FAILED)).toBe(true);
    expect(TERMINAL_STATUSES.has(JobStatus.CANCELLED)).toBe(true);
    expect(TERMINAL_STATUSES.has(JobStatus.PENDING)).toBe(false);
    expect(TERMINAL_STATUSES.has(JobStatus.RUNNING)).toBe(false);
    expect(TERMINAL_STATUSES.has(JobStatus.BLOCKED)).toBe(false);
  });

  it('coerceStatus is callable and falls back to PENDING for unknown', () => {
    expect(coerceStatus('running')).toBe(JobStatus.RUNNING);
    expect(coerceStatus('blocked')).toBe(JobStatus.BLOCKED);
    expect(coerceStatus('garbage')).toBe(JobStatus.PENDING);
    expect(coerceStatus(undefined)).toBe(JobStatus.PENDING);
  });

  it('transitionTimestamps is callable and returns the same shape', () => {
    const result = transitionTimestamps({
      status: JobStatus.RUNNING,
      startedAt: null,
      completedAt: null,
      now: 100,
    });
    expect(result).toEqual({ startedAt: 100, completedAt: null });
  });

  it('clears the start time when a running step returns to pending', () => {
    const result = transitionTimestamps({
      status: JobStatus.PENDING,
      startedAt: 50,
      completedAt: null,
      now: 100,
    });
    expect(result).toEqual({ startedAt: null, completedAt: null });
  });
});
