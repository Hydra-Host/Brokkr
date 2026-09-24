import { describe, expect, it } from 'vitest';
import { eventSkewMs, foldSagaSteps, groupSagaRuns, sagaRunOutcome, type SagaStepEvent } from '../saga-runs';

const at = (seconds: number) => new Date(Date.UTC(2026, 8, 16, 12, 0, seconds)).toISOString();

const event = (over: Partial<SagaStepEvent> = {}): SagaStepEvent => ({
  sagaName: 'provision',
  stepName: 'set_boot_order',
  eventType: 'stage_changed',
  status: 'complete',
  result: null,
  error: null,
  attempt: 0,
  occurredAt: at(0),
  recordedAt: at(0),
  origin: 'bridge',
  ...over,
});

const stepPair = (stepName: string, second: number, over: Partial<SagaStepEvent> = {}) => [
  event({ stepName, status: 'running', occurredAt: at(second), recordedAt: at(second), ...over }),
  event({ stepName, status: 'complete', occurredAt: at(second + 1), recordedAt: at(second + 1), ...over }),
];

const liveProvision = (): SagaStepEvent[] => [
  ...Array.from({ length: 25 }, (_, i) => stepPair(`step_${i + 1}`, i * 2)).flat(),
  event({ stepName: '(saga)', eventType: 'job_completed', status: 'complete', occurredAt: at(50), recordedAt: at(50) }),
  event({
    sagaName: 'phone_home',
    stepName: 'phone_home',
    eventType: 'phone_home',
    status: 'complete',
    origin: 'hub',
    occurredAt: at(55),
    recordedAt: at(55),
  }),
];

describe('groupSagaRuns', () => {
  it('groups consecutive events of one saga', () => {
    const runs = groupSagaRuns([
      event({ stepName: 'a' }),
      event({ stepName: 'b' }),
      event({ sagaName: 'power_on', stepName: 'a' }),
    ]);
    expect(runs.map((r) => [r.sagaName, r.events.length])).toEqual([
      ['provision', 2],
      ['power_on', 1],
    ]);
  });

  it('keeps two runs of one saga apart when another saga runs between', () => {
    const runs = groupSagaRuns([event({ sagaName: 'a' }), event({ sagaName: 'b' }), event({ sagaName: 'a' })]);
    expect(runs.map((r) => r.sagaName)).toEqual(['a', 'b', 'a']);
  });

  it('attaches hub rows to the surrounding run', () => {
    const runs = groupSagaRuns(liveProvision());
    expect(runs.map((r) => [r.sagaName, r.events.length])).toEqual([['provision', 52]]);
  });

  it('lets the first bridge row adopt a hub-opened run', () => {
    const runs = groupSagaRuns([
      event({ sagaName: 'stuck_sweep', stepName: 'stuck_sweep', origin: 'hub' }),
      event({ stepName: 'a', status: 'running' }),
      event({ stepName: 'a' }),
    ]);
    expect(runs.map((r) => [r.sagaName, r.events.length])).toEqual([['provision', 3]]);
  });

  it('opens a new run when a finished attempt runs again later', () => {
    const runs = groupSagaRuns([
      event({ stepName: 'a', status: 'running' }),
      event({ stepName: 'a', status: 'complete', occurredAt: at(1) }),
      event({ stepName: 'a', status: 'running', occurredAt: at(2) }),
      event({ stepName: 'a', status: 'complete', occurredAt: at(3) }),
    ]);
    expect(runs.map((r) => r.events.length)).toEqual([2, 2]);
  });

  it('keeps a running row that shares its clock with the finished attempt in the run', () => {
    const runs = groupSagaRuns([
      event({ stepName: 'a', status: 'running' }),
      event({ stepName: 'a', status: 'complete', occurredAt: at(1) }),
      event({ stepName: 'b', status: 'complete', occurredAt: at(2) }),
      event({ stepName: 'b', status: 'running', occurredAt: at(2) }),
      event({ stepName: 'c', status: 'running', occurredAt: at(3) }),
    ]);
    expect(runs.map((r) => r.events.length)).toEqual([5]);
  });

  it('keeps a resumed attempt in the run', () => {
    const runs = groupSagaRuns([
      event({ stepName: 'a', status: 'running' }),
      event({ stepName: 'a', status: 'running' }),
      event({ stepName: 'a', status: 'complete' }),
      event({ stepName: 'a', status: 'running', attempt: 1 }),
    ]);
    expect(runs.map((r) => r.events.length)).toEqual([4]);
  });

  it('returns no runs for no events', () => {
    expect(groupSagaRuns([])).toEqual([]);
  });
});

describe('foldSagaSteps', () => {
  it('folds running and complete into one complete step with its duration', () => {
    const steps = foldSagaSteps([
      event({ status: 'running', occurredAt: at(0) }),
      event({ status: 'complete', occurredAt: '2026-09-16T12:00:02.500Z' }),
    ]);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      status: 'complete',
      startedAt: at(0),
      endedAt: '2026-09-16T12:00:02.500Z',
      durationMs: 2500,
      eventCount: 2,
    });
  });

  it('keeps a running-only step running with no end', () => {
    const [step] = foldSagaSteps([event({ status: 'running' })]);
    expect(step).toMatchObject({ status: 'running', endedAt: null, durationMs: null });
  });

  it('reports a failed step with its error', () => {
    const [step] = foldSagaSteps([
      event({ status: 'running' }),
      event({ status: 'failed', error: 'ipmi timeout', occurredAt: at(3) }),
    ]);
    expect(step).toMatchObject({ status: 'failed', error: 'ipmi timeout', durationMs: 3000 });
  });

  it('gives each retry its own row', () => {
    const steps = foldSagaSteps([
      event({ status: 'running' }),
      event({ status: 'failed', error: 'first', occurredAt: at(1) }),
      event({ status: 'running', attempt: 1, occurredAt: at(2) }),
      event({ status: 'complete', attempt: 1, occurredAt: at(3) }),
    ]);
    expect(steps.map((s) => [s.attempt, s.status, s.error])).toEqual([
      [0, 'failed', 'first'],
      [1, 'complete', null],
    ]);
  });

  it('prefers the terminal event when it is ordered before the running one', () => {
    const [step] = foldSagaSteps([event({ status: 'complete' }), event({ status: 'running' })]);
    expect(step).toMatchObject({ status: 'complete', durationMs: 0 });
  });

  it('keeps the last non-null result and error', () => {
    const [step] = foldSagaSteps([
      event({ status: 'running', result: { phase: 'start' }, error: 'transient' }),
      event({ status: 'complete', result: null, error: null, occurredAt: at(1) }),
    ]);
    expect(step).toMatchObject({ result: { phase: 'start' }, error: 'transient' });
  });

  it('excludes outcome rows and marks hub rows', () => {
    const steps = foldSagaSteps(liveProvision());
    expect(steps).toHaveLength(26);
    expect(steps.some((s) => s.stepName === '(saga)')).toBe(false);
    expect(steps.at(-1)).toMatchObject({ stepName: 'phone_home', origin: 'hub', skewMs: null });
    expect(steps.filter((s) => s.origin === 'bridge')).toHaveLength(25);
  });

  it('excludes the plan-level failure row', () => {
    const steps = foldSagaSteps([event({ stepName: '__plan__', status: 'failed', error: 'plan failed' })]);
    expect(steps).toEqual([]);
  });

  it('records the largest bridge skew', () => {
    const [step] = foldSagaSteps([
      event({ status: 'running', occurredAt: at(0), recordedAt: at(6) }),
      event({ status: 'complete', occurredAt: at(1), recordedAt: at(3) }),
    ]);
    expect(step?.skewMs).toBe(6000);
  });

  it('keys steps by saga, step and attempt in first-seen order', () => {
    const steps = foldSagaSteps([event({ stepName: 'b' }), event({ stepName: 'a' }), event({ stepName: 'b' })]);
    expect(steps.map((s) => s.key)).toEqual(['provision:b:0', 'provision:a:0']);
  });

  it('carries the step label from its events and null when they have none', () => {
    const steps = foldSagaSteps([
      event({ status: 'running', operation: 'Set the boot order' }),
      event({ status: 'complete', operation: 'Set the boot order', occurredAt: at(1) }),
      event({ stepName: 'power_cycle', occurredAt: at(2) }),
    ]);
    expect(steps.map((s) => [s.stepName, s.operation])).toEqual([
      ['set_boot_order', 'Set the boot order'],
      ['power_cycle', null],
    ]);
  });
});

describe('sagaRunOutcome', () => {
  it('reads the (saga) completion row', () => {
    const outcome = sagaRunOutcome(liveProvision());
    expect(outcome).toEqual({ status: 'complete', at: at(50), error: null });
  });

  it('reads a failed (saga) row with its error', () => {
    const outcome = sagaRunOutcome([
      event({ status: 'running' }),
      event({ stepName: '(saga)', eventType: 'job_completed', status: 'failed', error: 'boom', occurredAt: at(2) }),
    ]);
    expect(outcome).toEqual({ status: 'failed', at: at(2), error: 'boom' });
  });

  it('reads a failed __plan__ row', () => {
    const outcome = sagaRunOutcome([event({ stepName: '__plan__', status: 'failed', error: 'plan failed' })]);
    expect(outcome).toEqual({ status: 'failed', at: at(0), error: 'plan failed' });
  });

  it('returns null while the saga is unfinished', () => {
    expect(sagaRunOutcome([event({ status: 'running' }), event({ status: 'complete' })])).toBeNull();
  });
});

describe('eventSkewMs', () => {
  it('returns ingest minus event time in milliseconds', () => {
    expect(eventSkewMs({ occurredAt: '2026-09-16T12:00:00.000Z', recordedAt: '2026-09-16T12:00:06.200Z' })).toBe(6200);
  });

  it('returns null when a clock does not parse', () => {
    expect(eventSkewMs({ occurredAt: 'not a clock', recordedAt: '2026-09-16T12:00:06.200Z' })).toBeNull();
  });
});
