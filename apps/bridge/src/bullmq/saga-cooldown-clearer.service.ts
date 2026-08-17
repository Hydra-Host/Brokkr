import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { getErrorMessage } from '../common/error-utils';

import { AutoCollectionService, cooldownKey } from '../auto-collection/auto-collection.service';

import type { SagaCooldownClearer } from './saga.handler';

export interface SagaCooldownCache {
  delete(key: string, jobId?: string): Promise<number>;
  setNxOwned(key: string, value: string, ttl: number, jobId?: string): Promise<boolean>;
}

// Once-per-job marker: a retried saga job re-runs this path with the SAME jobId; TTL only needs to outlive the retry window.
export function collectionEnqueuedKey(jobId: string): string {
  return `saga:job:${jobId}:auto_collection_enqueued`;
}

export const COLLECTION_ENQUEUED_MARKER_TTL_S = 3600;

export interface SagaCooldownLogger {
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

export const SAGA_COOLDOWN_CACHE = Symbol('SAGA_COOLDOWN_CACHE');
export const SAGA_COOLDOWN_LOGGER = Symbol('SAGA_COOLDOWN_LOGGER');

@Injectable()
export class SagaCooldownClearerService implements SagaCooldownClearer {
  constructor(
    @Inject(SAGA_COOLDOWN_CACHE) private readonly cache: SagaCooldownCache,
    private readonly autoCollection: AutoCollectionService,
    @Inject(SAGA_COOLDOWN_LOGGER) private readonly logger: SagaCooldownLogger,
  ) {}

  async clearCooldownAndEnqueue(deviceId: string, jobId: string): Promise<void> {
    await this.cache.delete(cooldownKey(deviceId), jobId);
    const token = randomUUID();
    const firstEnqueue = await this.cache.setNxOwned(
      collectionEnqueuedKey(jobId),
      token,
      COLLECTION_ENQUEUED_MARKER_TTL_S,
      jobId,
    );
    if (!firstEnqueue) return;
    // Fire-and-forget; on failure the marker delete must settle before the rejection, else a same-jobId retry sees the stale claim and skips the re-enqueue.
    void this.autoCollection.maybeEnqueueCollectionOnRegister(deviceId, { jobId }).catch(async (exc) => {
      await this.cache.delete(collectionEnqueuedKey(jobId), jobId);
      await this.logger.warning(`auto-collection schedule failed for device ${deviceId}: ${getErrorMessage(exc)}`, {
        jobId,
      });
    });
  }
}
