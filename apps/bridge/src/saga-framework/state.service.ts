import { JobStatus, TERMINAL_STATUSES } from './state.types';

export function coerceStatus(raw: unknown): JobStatus {
  if (typeof raw === 'string') {
    for (const value of Object.values(JobStatus)) {
      if (value === raw) {
        return value;
      }
    }
  }
  return JobStatus.PENDING;
}

export interface TransitionTimestampsResult {
  startedAt: number | null;
  completedAt: number | null;
}

export function transitionTimestamps(args: {
  status: JobStatus;
  startedAt: number | null;
  completedAt: number | null;
  now?: number;
}): TransitionTimestampsResult {
  const now = args.now ?? Date.now() / 1000;
  let nextStarted = args.startedAt;
  let nextCompleted = args.completedAt;

  if (args.status === JobStatus.PENDING) {
    nextStarted = null;
  }
  if (args.status === JobStatus.RUNNING && nextStarted === null) {
    nextStarted = now;
  }
  if (TERMINAL_STATUSES.has(args.status) && nextCompleted === null) {
    nextCompleted = now;
  }

  return { startedAt: nextStarted, completedAt: nextCompleted };
}
