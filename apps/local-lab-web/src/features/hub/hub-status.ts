import { UNKNOWN } from '@/components/ui/unknown';
import type { DeviceTokenRow, LifecycleJobEventRow, LifecycleJobRow, WebhookDeliveryRow } from '@/contract';

export const DELIVERY_TONE: Record<WebhookDeliveryRow['status'], string> = {
  SUCCESS: 'text-status-online',
  PENDING: 'text-status-info',
  RETRYING: 'text-status-warning',
  FAILED: 'text-status-offline',
};

export const PHASE_TONE: Record<LifecycleJobRow['phase'], string> = {
  REQUESTED: 'text-text-muted',
  AUTHORIZING: 'text-status-info',
  SCHEDULED: 'text-status-info',
  DEFERRED: 'text-status-warning',
  DISPATCHED: 'text-status-info',
  RUNNING: 'text-status-info',
  AWAITING_PHONE_HOME: 'text-status-warning',
  COMPLETED: 'text-status-online',
  FAILED: 'text-status-offline',
  ABORTED: 'text-status-offline',
};

/** DEFERRED and AWAITING_PHONE_HOME sit under "in flight" deliberately: the engine parks a job in
 *  both and expects it to move again, so grouping either with the terminal phases would read as done. */
export const PHASE_GROUPS: readonly { label: string; phases: readonly LifecycleJobRow['phase'][] }[] = [
  {
    label: 'in flight',
    phases: ['REQUESTED', 'AUTHORIZING', 'SCHEDULED', 'DEFERRED', 'DISPATCHED', 'RUNNING', 'AWAITING_PHONE_HOME'],
  },
  { label: 'terminal', phases: ['COMPLETED', 'FAILED', 'ABORTED'] },
];

export interface SagaRun {
  sagaName: string;
  events: LifecycleJobEventRow[];
}

/** Consecutive runs rather than one bucket per name: a job can enter the same saga twice, and
 *  merging those would present two attempts at a step as one. */
export function groupSagaRuns(events: readonly LifecycleJobEventRow[]): SagaRun[] {
  const runs: SagaRun[] = [];
  for (const event of events) {
    const current = runs.at(-1);
    if (current && current.sagaName === event.sagaName) current.events.push(event);
    else runs.push({ sagaName: event.sagaName, events: [event] });
  }
  return runs;
}

/** How far the hub's ingest trailed the bridge's own clock. Null when the bridge sent no time —
 *  which is not a zero skew, and is the only reason recordedAt is reported on its own. */
export function eventSkewMs(event: LifecycleJobEventRow): number | null {
  return event.occurredAtMs === null ? null : event.recordedAtMs - event.occurredAtMs;
}

/** A lock still held past its expiry is the signature of a wedged delivery — the reason this
 *  surface reads the database, since the hub api never returns these columns. */
export function isDeliveryLockStale(row: WebhookDeliveryRow, nowMs: number): boolean {
  return row.lockedBy !== null && row.lockExpiresAtMs !== null && row.lockExpiresAtMs < nowMs;
}

export type TokenRecency = 'live' | 'recent' | 'never' | 'unknown';

/** The live sentinel outranks the column: the column is throttled to sixty seconds, so a token
 *  used ten seconds ago can still read as never having been used by that measure alone. */
export function tokenRecency(row: DeviceTokenRow): TokenRecency {
  if (row.usedWithinThrottleWindow === null) return 'unknown';
  if (row.usedWithinThrottleWindow) return 'live';
  return row.lastUsedAtMs === null ? 'never' : 'recent';
}

export const RECENCY_LABEL: Record<TokenRecency, string> = {
  live: 'used just now',
  recent: 'last used',
  never: 'never used',
  unknown: UNKNOWN,
};

export const RECENCY_TITLE: Record<TokenRecency, string> = {
  live: 'the live sixty-second sentinel is present, so this token authenticated within the last minute',
  recent: 'from the durable column, which is throttled to sixty seconds and can lag by up to a minute',
  never: 'this token has never authenticated, which is a measurement rather than a gap',
  unknown: 'the recency probe could not be read, which is not the same as the token being idle',
};

export const ALARMING_TOKEN_EVENTS = new Set(['USED_AFTER_REVOKE', 'USED_AFTER_EXPIRY']);
