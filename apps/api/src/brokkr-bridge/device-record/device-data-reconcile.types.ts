import { CronExpression } from '@nestjs/schedule';

export const DEVICE_DATA_RECONCILE_QUEUE = 'device-data-reconcile';
export const DEVICE_DATA_RECONCILE_JOB = 'device-data-reconcile-sweep';
export const DEVICE_DATA_RECONCILE_SCHEDULE = CronExpression.EVERY_MINUTE;

export const DEVICE_DATA_RECONCILE_INTERVAL_MS = 60 * 1000;

export const DEVICE_DATA_RECONCILE_LOOKBACK_MS = 15 * 60 * 1000;

export const DEVICE_DATA_FULL_PURGE_INTERVAL_MS = 60 * 60 * 1000;

export const DEVICE_DATA_SYNC_CHUNK_SIZE = 500;

export const DEVICE_DATA_SWEEP_PAGE_SIZE = 1000;
