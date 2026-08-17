import { QUEUE_JOB_STATES, type QueueJobState } from '@/contract';

export type DatastoreTab = 'pg' | 'redis' | 'thanos' | 'queues';

export interface DatastoreSearch {
  tab: DatastoreTab;
  schema: string | undefined;
  table: string | undefined;
  page: number | undefined;
  tableFilter: string | undefined;
  key: string | undefined;
  match: string | undefined;
  metric: string | undefined;
  metricFilter: string | undefined;
  queuePrefix: string | undefined;
  queueName: string | undefined;
  queueFilter: string | undefined;
  jobState: QueueJobState | undefined;
  jobId: string | undefined;
  deviceId: string | undefined;
}

// annotated, not inferred: a new tab must widen the union deliberately rather than by being listed here
const DATASTORE_TAB_IDS: readonly DatastoreTab[] = ['pg', 'redis', 'thanos', 'queues'];

export function isDatastoreTab(value: unknown): value is DatastoreTab {
  return DATASTORE_TAB_IDS.some((id) => id === value);
}

export function toDatastoreTab(value: unknown): DatastoreTab {
  return isDatastoreTab(value) ? value : 'pg';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function pageIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function jobState(value: unknown): QueueJobState | undefined {
  return QUEUE_JOB_STATES.find((state) => state === value);
}

export function validateDatastoreSearch(search: Record<string, unknown>): DatastoreSearch {
  return {
    tab: toDatastoreTab(search.tab),
    schema: text(search.schema),
    table: text(search.table),
    page: pageIndex(search.page),
    tableFilter: text(search.tableFilter),
    key: text(search.key),
    match: text(search.match),
    metric: text(search.metric),
    metricFilter: text(search.metricFilter),
    queuePrefix: text(search.queuePrefix),
    queueName: text(search.queueName),
    queueFilter: text(search.queueFilter),
    jobState: jobState(search.jobState),
    jobId: text(search.jobId),
    deviceId: text(search.deviceId),
  };
}

// a search reducer must return every param, hence the total validator over prev rather than a spread;
// jobState stays unset so the operator lands on everything in flight for the device, not only failures
export function deviceQueuesSearch(prev: Record<string, unknown>, deviceId: string): DatastoreSearch {
  return { ...validateDatastoreSearch(prev), tab: 'queues', deviceId };
}

// the device filter is cleared with it: a link at one exact job must not land on a list that hides it
export function queueJobSearch(
  prev: Record<string, unknown>,
  queuePrefix: string,
  queueName: string,
  jobId: string,
): DatastoreSearch {
  return { ...validateDatastoreSearch(prev), tab: 'queues', queuePrefix, queueName, jobId, deviceId: undefined };
}
