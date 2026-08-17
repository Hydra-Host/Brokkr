import { CronExpression } from '@nestjs/schedule';

export const DEVICE_HEALTH_CHECK_QUEUE = 'device-health-check';
export const DEVICE_HEALTH_CHECK_JOB = 'device-health-check.sweep';
export const DEVICE_HEALTH_CHECK_SCHEDULE = CronExpression.EVERY_5_MINUTES;
export const DEVICE_HEALTH_CHECK_INTERVAL_MS = 5 * 60 * 1000;
