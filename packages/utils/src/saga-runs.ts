export type SagaOrigin = 'bridge' | 'hub';
export type SagaOutcomeStatus = 'complete' | 'failed';
export type SagaStepStatus = 'pending' | 'running' | SagaOutcomeStatus;

/** Structural rather than the api-client type: this package has no workspace dependencies. */
export interface SagaStepEvent {
  sagaName: string;
  stepName: string;
  operation?: string | null;
  eventType: string;
  status: string;
  result?: unknown;
  error: string | null;
  attempt: number;
  occurredAt: string;
  recordedAt: string;
  origin?: SagaOrigin;
}

export type SagaRunEvent = Pick<
  SagaStepEvent,
  'sagaName' | 'stepName' | 'status' | 'attempt' | 'origin' | 'occurredAt'
>;

export interface SagaRun<E extends SagaRunEvent> {
  sagaName: string;
  events: E[];
}

export interface SagaStep {
  key: string;
  sagaName: string;
  stepName: string;
  operation: string | null;
  attempt: number;
  origin: SagaOrigin;
  status: SagaStepStatus;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  result: unknown;
  error: string | null;
  eventCount: number;
  skewMs: number | null;
}

export interface SagaRunOutcome {
  status: SagaOutcomeStatus;
  at: string;
  error: string | null;
}

/** Rows that close a saga instead of describing a step: the job.completed row and the plan-level failure. */
export const SAGA_OUTCOME_STEP_NAMES: ReadonlySet<string> = new Set(['(saga)', '__plan__']);
export const TERMINAL_STEP_STATUSES: ReadonlySet<string> = new Set<SagaOutcomeStatus>(['complete', 'failed']);

function isTerminalStatus(status: string): status is SagaOutcomeStatus {
  return TERMINAL_STEP_STATUSES.has(status);
}

function attemptKey(event: Pick<SagaRunEvent, 'stepName' | 'attempt'>): string {
  return `${event.stepName}:${event.attempt}`;
}

function clock(iso: string): number {
  return new Date(iso).getTime();
}

/** Consecutive runs, not one bucket per name; hub rows carry their own sagaName and join the run around them. */
export function groupSagaRuns<E extends SagaRunEvent>(events: readonly E[]): SagaRun<E>[] {
  const runs: SagaRun<E>[] = [];
  let finished = new Map<string, number>();
  let openedByHub = false;
  const open = (event: E) => {
    runs.push({ sagaName: event.sagaName, events: [event] });
    finished = new Map();
  };
  for (const event of events) {
    const current = runs.at(-1);
    if (event.origin === 'hub') {
      if (current) current.events.push(event);
      else {
        open(event);
        openedByHub = true;
      }
      continue;
    }
    if (!current) open(event);
    else if (openedByHub) {
      current.sagaName = event.sagaName;
      current.events.push(event);
    } else if (current.sagaName !== event.sagaName || restartsAttempt(event, finished)) open(event);
    else current.events.push(event);
    openedByHub = false;
    if (isTerminalStatus(event.status)) finished.set(attemptKey(event), clock(event.occurredAt));
  }
  return runs;
}

/** A running row at or before its attempt's terminal clock is the late half of an instant step, not a restart. */
function restartsAttempt(event: SagaRunEvent, finished: ReadonlyMap<string, number>): boolean {
  const endedAt = finished.get(attemptKey(event));
  if (endedAt === undefined) return false;
  return !(event.status === 'running' && clock(event.occurredAt) <= endedAt);
}

interface StepFold {
  first: SagaStepEvent;
  runningAt: string | null;
  terminal: { status: SagaOutcomeStatus; at: string } | null;
  result: unknown;
  error: string | null;
  eventCount: number;
  skewMs: number | null;
}

/** One row per (saga, step, attempt); a terminal event wins whatever its position, as running and complete can share a second. */
export function foldSagaSteps(events: readonly SagaStepEvent[]): SagaStep[] {
  const folds = new Map<string, StepFold>();
  for (const event of events) {
    if (SAGA_OUTCOME_STEP_NAMES.has(event.stepName)) continue;
    const key = `${event.sagaName}:${attemptKey(event)}`;
    const fold = folds.get(key) ?? {
      first: event,
      runningAt: null,
      terminal: null,
      result: null,
      error: null,
      eventCount: 0,
      skewMs: null,
    };
    folds.set(key, fold);
    fold.eventCount += 1;
    if (event.status === 'running' && (fold.runningAt === null || clock(event.occurredAt) < clock(fold.runningAt))) {
      fold.runningAt = event.occurredAt;
    }
    if (
      isTerminalStatus(event.status) &&
      (fold.terminal === null || clock(event.occurredAt) >= clock(fold.terminal.at))
    ) {
      fold.terminal = { status: event.status, at: event.occurredAt };
    }
    if (event.result !== null && event.result !== undefined) fold.result = event.result;
    if (event.error !== null) fold.error = event.error;
    const skew = (event.origin ?? 'bridge') === 'bridge' ? eventSkewMs(event) : null;
    if (skew !== null && (fold.skewMs === null || Math.abs(skew) > Math.abs(fold.skewMs))) fold.skewMs = skew;
  }
  return [...folds].map(([key, fold]) => toStep(key, fold));
}

function toStep(key: string, fold: StepFold): SagaStep {
  const { first, runningAt, terminal } = fold;
  const startedAt = runningAt ?? first.occurredAt;
  const endedAt = terminal?.at ?? null;
  const elapsed = endedAt === null ? null : clock(endedAt) - clock(startedAt);
  return {
    key,
    sagaName: first.sagaName,
    stepName: first.stepName,
    operation: first.operation ?? null,
    attempt: first.attempt,
    origin: first.origin ?? 'bridge',
    status: terminal ? terminal.status : runningAt === null ? 'pending' : 'running',
    startedAt,
    endedAt,
    durationMs: elapsed !== null && Number.isFinite(elapsed) ? Math.max(0, elapsed) : null,
    result: fold.result,
    error: fold.error,
    eventCount: fold.eventCount,
    skewMs: fold.skewMs,
  };
}

/** The run footer: the last terminal outcome row, or null while the saga is still going. */
export function sagaRunOutcome(events: readonly SagaStepEvent[]): SagaRunOutcome | null {
  let outcome: SagaRunOutcome | null = null;
  for (const event of events) {
    if (SAGA_OUTCOME_STEP_NAMES.has(event.stepName) && isTerminalStatus(event.status)) {
      outcome = { status: event.status, at: event.occurredAt, error: event.error };
    }
  }
  return outcome;
}

/** Hub ingest clock minus the event clock, in milliseconds; null when either clock does not parse. */
export function eventSkewMs(event: { occurredAt: string; recordedAt: string }): number | null {
  const skew = clock(event.recordedAt) - clock(event.occurredAt);
  return Number.isNaN(skew) ? null : skew;
}
