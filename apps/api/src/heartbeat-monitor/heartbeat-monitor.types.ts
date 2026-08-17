import { CronExpression } from '@nestjs/schedule';

export const HEARTBEAT_MONITOR_QUEUE = 'heartbeat-monitor';
export const HEARTBEAT_MONITOR_JOB = 'heartbeat-monitor.sweep';
export const HEARTBEAT_MONITOR_SCHEDULE = CronExpression.EVERY_MINUTE;
export const HEARTBEAT_MONITOR_INTERVAL_MS = 60 * 1000;
