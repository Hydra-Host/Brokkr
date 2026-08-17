export const SAGA_QUEUE_NAMES = ['lifecycle', 'collection'] as const;
export type SagaQueueName = (typeof SAGA_QUEUE_NAMES)[number];

// every zone fans into one global inbox, so this pair is not zone-prefixed
export const RESULTS_QUEUE_PREFIX = 'results';
export const RESULTS_QUEUE_NAME = 'inbox';

export const HUB_QUEUE_PREFIX = 'bull';

export const QUEUE_LIST_STATES = ['wait', 'active', 'paused'] as const;
export const QUEUE_ZSET_STATES = ['delayed', 'completed', 'failed', 'waiting-children', 'prioritized'] as const;
export const QUEUE_SET_STATES = ['stalled'] as const;

export type QueueListState = (typeof QUEUE_LIST_STATES)[number];
export type QueueZsetState = (typeof QUEUE_ZSET_STATES)[number];
export type QueueSetState = (typeof QUEUE_SET_STATES)[number];

// independent of QUEUE_LIST_STATES on purpose: this set gates destructive ops, so a display-only
// vocabulary change must not silently shrink what the guard counts as in flight
export const IN_FLIGHT_LIST_STATES = ['wait', 'active', 'paused'] as const satisfies readonly QueueListState[];
export const IN_FLIGHT_ZSET_STATES: readonly QueueZsetState[] = ['delayed', 'prioritized'];

// likewise independent of the display vocabulary on purpose: a clean bulk-deletes, so 'active'
// (locked in-flight work) and 'waiting-children' (whose removal orphans the children) are never in it
export const QUEUE_CLEANABLE_STATES = [
  'completed',
  'failed',
  'wait',
  'paused',
  'delayed',
  'prioritized',
] as const satisfies readonly (QueueListState | QueueZsetState)[];

export function queueKey(prefix: string, name: string, suffix: string): string {
  return `${prefix}:${name}:${suffix}`;
}

export interface ParsedSagaJobId {
  deviceId: string;
  sagaName: string | null;
  planId: string | null;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const LEADING_UUID = new RegExp(`^(${UUID})-(.+)$`);
const TRAILING_UUID = new RegExp(`^(.+)-(${UUID})$`);
const PREFIXED_UUID = new RegExp(`^.+?-(${UUID})(?:-.+)?$`);

// positional rather than enum-driven: the hub's saga-name enum is not importable from here
export function parseSagaJobId(jobId: string): ParsedSagaJobId | null {
  const head = LEADING_UUID.exec(jobId);
  if (head) {
    const deviceId = head[1];
    const rest = head[2];
    const tail = TRAILING_UUID.exec(rest);
    if (tail) return { deviceId, sagaName: tail[1], planId: tail[2] };
    return { deviceId, sagaName: rest, planId: null };
  }

  // a buried uuid means a coalesce key or the hub-local device-status-effects id; neither surrounds it with a saga name
  const prefixed = PREFIXED_UUID.exec(jobId);
  return prefixed ? { deviceId: prefixed[1], sagaName: null, planId: null } : null;
}
