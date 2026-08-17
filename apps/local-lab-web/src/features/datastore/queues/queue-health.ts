import type { QueueCounts, QueueJob, QueueJobObservedState, QueueJobPage, QueueSummary } from '@/contract';

// stalled is a queue-level SCARD rather than a job state, but it reads as one everywhere in this view
export type QueueStateName = QueueJobObservedState | 'stalled';

export interface QueueAddress {
  prefix: string;
  name: string;
}

export const QUEUE_COUNT_COLUMNS: readonly (keyof QueueCounts)[] = [
  'wait',
  'active',
  'delayed',
  'prioritized',
  'waiting-children',
  'paused',
  'completed',
  'failed',
];

const STATE_TONE: Record<QueueStateName, string> = {
  wait: 'text-text-muted',
  active: 'text-status-warning',
  // a re-delay for agent handoff or lock contention costs no attempt, so delayed is healthy in-flight
  delayed: 'text-status-info',
  prioritized: 'text-text-muted',
  'waiting-children': 'text-text-muted',
  paused: 'text-text-dim',
  completed: 'text-status-online',
  failed: 'text-status-offline',
  stalled: 'text-status-offline',
  unknown: 'text-text-dim',
};

export function isAlarmingState(state: QueueStateName): boolean {
  return state === 'failed' || state === 'stalled';
}

export function stateTone(state: QueueStateName): string {
  return STATE_TONE[state];
}

export function countTone(state: QueueStateName, value: number): string {
  return value === 0 ? 'text-text-dim' : stateTone(state);
}

export function isQueueUnreadable(queue: QueueSummary): boolean {
  return queue.readError !== null;
}

export function queueId(queue: QueueAddress): string {
  return `${queue.prefix}/${queue.name}`;
}

export function sameQueue(a: QueueAddress, b: QueueAddress | null): boolean {
  return b !== null && a.prefix === b.prefix && a.name === b.name;
}

export interface QueueTotals {
  queues: number;
  unreadable: number;
  inFlight: number;
  completed: number;
  failed: number;
  stalled: number;
  pausedQueues: number;
  pausedUnknown: number;
  workers: number;
  workersUnknown: number;
}

// unreadable rows contribute only to their own tally: their placeholder zeros would report a wedged queue
// as a healthy empty one. a failed paused/workers probe nulls only that field — the counts still fold in.
export function summarizeQueues(queues: readonly QueueSummary[]): QueueTotals {
  const totals: QueueTotals = {
    queues: queues.length,
    unreadable: 0,
    inFlight: 0,
    completed: 0,
    failed: 0,
    stalled: 0,
    pausedQueues: 0,
    pausedUnknown: 0,
    workers: 0,
    workersUnknown: 0,
  };
  for (const queue of queues) {
    if (isQueueUnreadable(queue)) {
      totals.unreadable += 1;
      continue;
    }
    totals.inFlight += queue.inFlight;
    totals.completed += queue.counts.completed;
    totals.failed += queue.counts.failed;
    totals.stalled += queue.stalled;
    if (queue.workers === null) totals.workersUnknown += 1;
    else totals.workers += queue.workers;
    if (queue.paused === null) totals.pausedUnknown += 1;
    else if (queue.paused) totals.pausedQueues += 1;
  }
  return totals;
}

export interface JobPaging {
  offset: number;
  more: boolean;
}

export const INITIAL_PAGING: JobPaging = { offset: 0, more: false };

// limit is the window applied to each state list, so the next window starts one full limit further in —
// never at prev.offset + jobs.length, which sums across states
export function advancePaging(prev: JobPaging, page: QueueJobPage, reset: boolean): JobPaging {
  const offset = prev.offset + page.limit;
  // past the discovery cap the id scan restarts at the keyspace start every request, so a further offset
  // only re-reads the same ids; an empty follow-up page likewise proves there is nothing further
  const exhausted = !reset && page.jobs.length === 0;
  return { offset, more: page.truncated && !page.discoveryCapped && !exhausted };
}

export function mergeJobs(prev: readonly QueueJob[], next: readonly QueueJob[]): QueueJob[] {
  const byId = new Map(prev.map((job) => [job.id, job]));
  for (const job of next) byId.set(job.id, job);
  return [...byId.values()];
}

export function epochLabel(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return '—';
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

export function durationLabel(from: number | null, to: number | null): string | null {
  if (from === null || to === null || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  const ms = to - from;
  if (ms < 0) return null;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
