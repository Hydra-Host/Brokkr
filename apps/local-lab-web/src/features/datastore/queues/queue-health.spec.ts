import { describe, expect, it } from 'vitest';

import type { QueueCounts, QueueJob, QueueJobPage, QueueSummary } from '@/contract';

import {
  INITIAL_PAGING,
  advancePaging,
  countTone,
  durationLabel,
  epochLabel,
  isAlarmingState,
  isQueueUnreadable,
  mergeJobs,
  queueId,
  sameQueue,
  stateTone,
  summarizeQueues,
} from './queue-health';

const ZERO: QueueCounts = {
  wait: 0,
  active: 0,
  paused: 0,
  delayed: 0,
  prioritized: 0,
  'waiting-children': 0,
  completed: 0,
  failed: 0,
};

function queue(overrides: Partial<QueueSummary> = {}): QueueSummary {
  return {
    prefix: 'zone-a',
    name: 'lifecycle',
    kind: 'saga',
    counts: { ...ZERO },
    stalled: 0,
    paused: false,
    workers: 1,
    inFlight: 0,
    readError: null,
    ...overrides,
  };
}

function job(overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    id: 'job-1',
    name: 'saga.run',
    state: 'wait',
    attemptsMade: 0,
    timestamp: 1000,
    processedOn: null,
    finishedOn: null,
    delay: 0,
    failedReason: null,
    deviceId: null,
    sagaName: null,
    planId: null,
    sealed: false,
    zoneId: null,
    ...overrides,
  };
}

function page(overrides: Partial<QueueJobPage> = {}): QueueJobPage {
  return {
    queue: { prefix: 'zone-a', name: 'lifecycle', kind: 'saga' },
    states: ['wait'],
    limit: 50,
    offset: 0,
    deviceId: null,
    deviceFilterSupported: true,
    cap: 200,
    jobs: [],
    truncated: false,
    discoveryCapped: false,
    ...overrides,
  };
}

describe('isAlarmingState', () => {
  it('alarms on failed and stalled', () => {
    expect(isAlarmingState('failed')).toBe(true);
    expect(isAlarmingState('stalled')).toBe(true);
  });

  it('does not alarm on delayed', () => {
    expect(isAlarmingState('delayed')).toBe(false);
  });

  it('does not alarm on any other in-flight or terminal state', () => {
    for (const state of [
      'wait',
      'active',
      'paused',
      'prioritized',
      'waiting-children',
      'completed',
      'unknown',
    ] as const) {
      expect(isAlarmingState(state)).toBe(false);
    }
  });
});

describe('stateTone', () => {
  it('tones delayed away from the failure color', () => {
    expect(stateTone('delayed')).not.toBe(stateTone('failed'));
    expect(stateTone('delayed')).not.toContain('status-offline');
  });

  it('tones failed and stalled with the failure color', () => {
    expect(stateTone('failed')).toContain('status-offline');
    expect(stateTone('stalled')).toContain('status-offline');
  });
});

describe('countTone', () => {
  it('dims a zero even for an alarming state', () => {
    expect(countTone('failed', 0)).toBe('text-text-dim');
  });

  it('keeps the state tone for a non-zero count', () => {
    expect(countTone('failed', 3)).toBe(stateTone('failed'));
  });
});

describe('isQueueUnreadable', () => {
  it('separates a failed read from a genuinely empty queue', () => {
    expect(isQueueUnreadable(queue({ readError: 'ECONNREFUSED' }))).toBe(true);
    expect(isQueueUnreadable(queue())).toBe(false);
  });
});

describe('queueId and sameQueue', () => {
  it('addresses a queue by both halves', () => {
    expect(queueId({ prefix: 'zone-a', name: 'lifecycle' })).toBe('zone-a/lifecycle');
    expect(sameQueue(queue(), { prefix: 'zone-a', name: 'lifecycle' })).toBe(true);
    expect(sameQueue(queue(), { prefix: 'zone-b', name: 'lifecycle' })).toBe(false);
    expect(sameQueue(queue(), { prefix: 'zone-a', name: 'collection' })).toBe(false);
    expect(sameQueue(queue(), null)).toBe(false);
  });
});

describe('summarizeQueues', () => {
  it('counts an unreadable queue without folding its placeholder zeros into the totals', () => {
    const totals = summarizeQueues([
      queue({ name: 'lifecycle', inFlight: 4, counts: { ...ZERO, failed: 2, completed: 7 }, stalled: 1, workers: 2 }),
      queue({ name: 'collection', readError: 'ECONNREFUSED', workers: 9 }),
    ]);
    expect(totals).toEqual({
      queues: 2,
      unreadable: 1,
      inFlight: 4,
      completed: 7,
      failed: 2,
      stalled: 1,
      pausedQueues: 0,
      pausedUnknown: 0,
      workers: 2,
      workersUnknown: 0,
    });
  });

  it('reports a paused queue', () => {
    expect(summarizeQueues([queue({ paused: true })]).pausedQueues).toBe(1);
  });

  it('keeps the counts of a queue whose worker probe failed and tallies the unknown separately', () => {
    const totals = summarizeQueues([
      queue({ name: 'probed-q', inFlight: 3, counts: { ...ZERO, failed: 5, completed: 6 }, stalled: 2, workers: null }),
    ]);
    expect(totals).toMatchObject({
      unreadable: 0,
      inFlight: 3,
      failed: 5,
      completed: 6,
      stalled: 2,
      workers: 0,
      workersUnknown: 1,
    });
  });

  it('does not let an unknown worker count masquerade as a measured zero', () => {
    const unknown = summarizeQueues([queue({ workers: null })]);
    const measured = summarizeQueues([queue({ workers: 0 })]);
    expect(unknown.workers).toBe(measured.workers);
    expect(unknown.workersUnknown).toBe(1);
    expect(measured.workersUnknown).toBe(0);
  });

  it('separates an unknown pause state from a queue known not to be paused', () => {
    expect(summarizeQueues([queue({ paused: null })])).toMatchObject({ pausedQueues: 0, pausedUnknown: 1 });
    expect(summarizeQueues([queue({ paused: false })])).toMatchObject({ pausedQueues: 0, pausedUnknown: 0 });
  });

  it('excludes an unreadable row from the totals while keeping a probe-failed row in them', () => {
    const totals = summarizeQueues([
      queue({ name: 'wedged-q', readError: 'ECONNREFUSED', inFlight: 99, counts: { ...ZERO, failed: 99 } }),
      queue({ name: 'probed-q', workers: null, paused: null, inFlight: 4, counts: { ...ZERO, failed: 1 } }),
    ]);
    expect(totals).toMatchObject({ queues: 2, unreadable: 1, inFlight: 4, failed: 1, workersUnknown: 1 });
  });

  it('reports nothing for an empty inventory', () => {
    expect(summarizeQueues([])).toMatchObject({ queues: 0, unreadable: 0, inFlight: 0 });
  });
});

describe('advancePaging', () => {
  it('advances by the per-state limit rather than the job count', () => {
    const next = advancePaging(
      INITIAL_PAGING,
      page({ limit: 50, jobs: [job(), job({ id: 'job-2' })], truncated: true }),
      true,
    );
    expect(next).toEqual({ offset: 50, more: true });
    expect(advancePaging(next, page({ limit: 50, jobs: [job({ id: 'job-3' })], truncated: true }), false)).toEqual({
      offset: 100,
      more: true,
    });
  });

  it('stops when the server reports the window was not truncated', () => {
    expect(advancePaging({ offset: 50, more: true }, page({ limit: 50, truncated: false }), false)).toEqual({
      offset: 100,
      more: false,
    });
  });

  it('offers a further offset on a truncated device page the discovery cap did not cut', () => {
    const next = advancePaging(
      INITIAL_PAGING,
      page({ deviceId: 'dev-1', jobs: [job()], truncated: true, discoveryCapped: false }),
      true,
    );
    expect(next.more).toBe(true);
  });

  it('withholds a further offset once the discovery cap pins truncated true on every page', () => {
    const capped = page({ deviceId: 'dev-1', jobs: [job()], truncated: true, discoveryCapped: true });
    expect(advancePaging(INITIAL_PAGING, capped, true).more).toBe(false);
    expect(advancePaging({ offset: 50, more: true }, capped, false).more).toBe(false);
  });

  it('stops paging when a follow-up page comes back empty', () => {
    expect(advancePaging({ offset: 50, more: true }, page({ jobs: [], truncated: true }), false).more).toBe(false);
  });

  it('does not treat an empty first page as one it has already read past', () => {
    expect(advancePaging(INITIAL_PAGING, page({ jobs: [], truncated: true }), true).more).toBe(true);
  });
});

describe('mergeJobs', () => {
  it('keeps first-seen order while adopting the newer read of a job that moved', () => {
    const merged = mergeJobs(
      [job({ id: 'a', state: 'wait' }), job({ id: 'b', state: 'wait' })],
      [job({ id: 'a', state: 'active' }), job({ id: 'c', state: 'delayed' })],
    );
    expect(merged.map((j) => j.id)).toEqual(['a', 'b', 'c']);
    expect(merged[0].state).toBe('active');
  });
});

describe('epochLabel', () => {
  it('renders an epoch as a readable stamp and a null as a dash', () => {
    expect(epochLabel(0)).toBe('1970-01-01 00:00:00.000');
    expect(epochLabel(null)).toBe('—');
    expect(epochLabel(Number.NaN)).toBe('—');
  });
});

describe('durationLabel', () => {
  it('scales the unit with the gap', () => {
    expect(durationLabel(0, 250)).toBe('250ms');
    expect(durationLabel(0, 1500)).toBe('1.5s');
    expect(durationLabel(0, 125_000)).toBe('2m 5s');
  });

  it('has no answer for a missing or reversed pair', () => {
    expect(durationLabel(null, 5)).toBeNull();
    expect(durationLabel(5, null)).toBeNull();
    expect(durationLabel(500, 100)).toBeNull();
  });
});
