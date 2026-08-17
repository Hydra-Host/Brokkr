import { CronExpression } from '@nestjs/schedule';

export const INVENTORY_COLLECTION_QUEUE = 'inventory-collection';
export const INVENTORY_COLLECTION_JOB = 'inventory-collection.sweep';
export const INVENTORY_COLLECTION_SCHEDULE = CronExpression.EVERY_HOUR;
export const INVENTORY_COLLECTION_INTERVAL_MS = 60 * 60 * 1000;
