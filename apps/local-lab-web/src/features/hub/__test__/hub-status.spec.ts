import { describe, expect, it } from 'vitest';

import type { LifecycleJobEventRow, LifecycleJobRow } from '@/contract';
import { LIFECYCLE_JOB_PHASES } from '@/contract';

import { eventSkewMs, groupSagaRuns, PHASE_GROUPS } from '../hub-status';

const NOW = 1_700_000_000_000;

const event = (over: Partial<LifecycleJobEventRow> = {}): LifecycleJobEventRow => ({
  id: 'evt-1',
  sagaName: 'provision',
  stepName: 'wipe',
  eventType: 'step',
  status: 'complete',
  attempt: 0,
  error: null,
  occurredAtMs: NOW,
  recordedAtMs: NOW,
  ...over,
});

describe('PHASE_GROUPS', () => {
  it('covers every engine phase exactly once, so a new phase cannot fall out of the filter', () => {
    const grouped = PHASE_GROUPS.flatMap((group) => group.phases);

    expect([...grouped].sort()).toEqual([...LIFECYCLE_JOB_PHASES].sort());
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('groups the two parked phases with in flight, not with terminal', () => {
    const inFlight = PHASE_GROUPS.find((group) => group.label === 'in flight');

    expect(inFlight?.phases).toContain('DEFERRED');
    expect(inFlight?.phases).toContain('AWAITING_PHONE_HOME');
  });
});

describe('groupSagaRuns', () => {
  it('keeps a re-entered saga as two runs rather than one merged block', () => {
    const runs = groupSagaRuns([event({ id: 'a' }), event({ id: 'b', sagaName: 'collection' }), event({ id: 'c' })]);

    expect(runs.map((run) => run.sagaName)).toEqual(['provision', 'collection', 'provision']);
    expect(runs.map((run) => run.events.length)).toEqual([1, 1, 1]);
  });

  it('keeps consecutive steps of one saga together', () => {
    const runs = groupSagaRuns([event({ id: 'a' }), event({ id: 'b', stepName: 'install' })]);

    expect(runs).toHaveLength(1);
    expect(runs[0].events.map((entry) => entry.stepName)).toEqual(['wipe', 'install']);
  });

  it('preserves the order it was given', () => {
    const runs = groupSagaRuns([event({ id: 'a' }), event({ id: 'b', stepName: 'install' })]);

    expect(runs[0].events[0].id).toBe('a');
  });

  it('returns nothing for a job with no events', () => {
    expect(groupSagaRuns([])).toEqual([]);
  });
});

describe('eventSkewMs', () => {
  it('reports how far the hub trailed the bridge', () => {
    expect(eventSkewMs(event({ occurredAtMs: NOW - 4000, recordedAtMs: NOW }))).toBe(4000);
  });

  it('reports unknown rather than zero when the bridge sent no time', () => {
    expect(eventSkewMs(event({ occurredAtMs: null }))).toBeNull();
    expect(eventSkewMs(event({ occurredAtMs: NOW, recordedAtMs: NOW }))).toBe(0);
  });

  it('reports a bridge clock ahead of the hub as negative rather than clamping it', () => {
    expect(eventSkewMs(event({ occurredAtMs: NOW + 3000, recordedAtMs: NOW }))).toBe(-3000);
  });
});

describe('the phase filter vocabulary', () => {
  it('names only phases the row type carries', () => {
    const phases: readonly LifecycleJobRow['phase'][] = PHASE_GROUPS.flatMap((group) => group.phases);

    for (const phase of phases) expect(LIFECYCLE_JOB_PHASES).toContain(phase);
  });
});
