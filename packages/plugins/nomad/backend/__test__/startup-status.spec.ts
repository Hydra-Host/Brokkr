import { describe, expect, it } from 'vitest';

import { NomadStartupStatusSchema } from '../../schemas';
import { evaluateNomadStartup } from '../startup-status';
import type { NomadAllocStub } from '../types/nomad-api';

const SOFT = 60_000;
const HARD = 300_000;

const evaluate = (allocations: NomadAllocStub[], elapsedMs = 0) =>
  evaluateNomadStartup({ allocations, elapsedMs, softTimeoutMs: SOFT, hardTimeoutMs: HARD });

const runningAlloc = (id: string, tasks: Record<string, string> = { app: 'running' }): NomadAllocStub => ({
  ID: id,
  JobID: 'job-1',
  ClientStatus: 'running',
  TaskStates: Object.fromEntries(
    Object.entries(tasks).map(([name, state]) => [name, { State: state, Failed: false }]),
  ),
});

describe('evaluateNomadStartup', () => {
  it('reports running/ok when every alloc and task is running', () => {
    const result = evaluate([runningAlloc('a1', { app: 'running', sidecar: 'running' }), runningAlloc('a2')]);

    expect(() => NomadStartupStatusSchema.parse(result)).not.toThrow();
    expect(result.stage).toBe('running');
    expect(result.done).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('does not fail when a lifecycle task is dead without Failed', () => {
    const allocations: NomadAllocStub[] = [
      {
        ID: 'a1',
        JobID: 'job-1',
        ClientStatus: 'running',
        TaskStates: {
          main: { State: 'running', Failed: false },
          init: { State: 'dead', Failed: false },
        },
      },
    ];

    const result = evaluate(allocations, SOFT + 1);

    expect(result.stage).toBe('running');
    expect(result.done).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.tasks.find((t) => t.task === 'init')).toMatchObject({ state: 'dead', failed: false });
  });

  it('fails when a task has Failed: true', () => {
    const allocations: NomadAllocStub[] = [
      {
        ID: 'a1',
        JobID: 'job-1',
        ClientStatus: 'running',
        TaskStates: {
          main: { State: 'running', Failed: false },
          init: {
            State: 'dead',
            Failed: true,
            Events: [{ Type: 'Terminated', DisplayMessage: 'init crashed' }],
          },
        },
      },
    ];

    const result = evaluate(allocations);
    expect(result.stage).toBe('failed');
    expect(result.ok).toBe(false);
    expect(result.failures).toContain('init crashed');
  });

  it('reports scheduling while waiting for first allocation', () => {
    const result = evaluate([]);
    expect(result.stage).toBe('scheduling');
    expect(result.done).toBe(false);
    expect(result.ok).toBeNull();
  });

  it('times out when hard timeout elapses without a terminal verdict', () => {
    const result = evaluate(
      [
        {
          ID: 'a1',
          JobID: 'job-1',
          ClientStatus: 'pending',
          TaskStates: { app: { State: 'pending', Failed: false } },
        },
      ],
      HARD,
    );
    expect(result.stage).toBe('timed_out');
    expect(result.done).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.message).toBe('job startup timed out');
  });

  it('fails when job is dead with no live allocations', () => {
    const result = evaluateNomadStartup({
      allocations: [],
      elapsedMs: 1_000,
      softTimeoutMs: SOFT,
      hardTimeoutMs: HARD,
      jobStatus: 'dead',
      jobVersion: 1,
    });
    expect(result.stage).toBe('failed');
    expect(result.done).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.failures[0]).toMatch(/without placing any allocations/i);
  });

  it('withholds terminal success when jobVersion is null (spec read failed)', () => {
    const result = evaluateNomadStartup({
      allocations: [runningAlloc('a1')],
      elapsedMs: 0,
      softTimeoutMs: SOFT,
      hardTimeoutMs: HARD,
      jobVersion: null,
    });
    expect(result.stage).toBe('running');
    expect(result.done).toBe(false);
    expect(result.ok).toBeNull();
  });
});

const completeAlloc = (id: string): NomadAllocStub => ({
  ID: id,
  JobID: 'job-1',
  ClientStatus: 'complete',
  TaskStates: { app: { State: 'dead', Failed: false } },
});

describe('evaluateNomadStartup oneShot=true', () => {
  it('reports completed when all allocs are complete and version is verified', () => {
    const result = evaluateNomadStartup({
      allocations: [completeAlloc('a1'), completeAlloc('a2')],
      elapsedMs: 0,
      softTimeoutMs: SOFT,
      hardTimeoutMs: HARD,
      oneShot: true,
      jobVersion: 1,
    });
    expect(result.stage).toBe('completed');
    expect(result.done).toBe(true);
    expect(result.ok).toBe(true);
  });

  it('withholds terminal success when allocs are complete but jobVersion is null', () => {
    const result = evaluateNomadStartup({
      allocations: [completeAlloc('a1')],
      elapsedMs: 0,
      softTimeoutMs: SOFT,
      hardTimeoutMs: HARD,
      oneShot: true,
      jobVersion: null,
    });
    expect(result.stage).toBe('starting');
    expect(result.done).toBe(false);
    expect(result.ok).toBeNull();
  });

  it('keeps polling while allocs are running mid-job', () => {
    const result = evaluateNomadStartup({
      allocations: [runningAlloc('a1')],
      elapsedMs: 0,
      softTimeoutMs: SOFT,
      hardTimeoutMs: HARD,
      oneShot: true,
      jobVersion: 1,
    });
    expect(result.stage).toBe('running');
    expect(result.done).toBe(false);
    expect(result.ok).toBeNull();
  });
});

