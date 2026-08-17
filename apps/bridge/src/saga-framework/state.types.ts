// String values are persisted to Redis and travel over BullMQ payloads — do not rename.
export enum JobStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  BLOCKED = 'blocked',
  COMPLETED = 'complete',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
}

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  JobStatus.COMPLETED,
  JobStatus.FAILED,
  JobStatus.CANCELLED,
]);
