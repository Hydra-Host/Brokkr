import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { getErrorMessage } from '../common/error-utils';

import { NIL_DEVICE_ID, deviceRecord } from '../common/redis/redis-keys';
import { deviceRecordSchema, type DeviceRecord } from '../device-record/device-record.schema';

export const COOLDOWN_BOOTSTRAP_S = 60;
export const COOLDOWN_REFRESH_S = 3600;

export function cooldownKey(deviceId: string): string {
  return `device:${deviceId}:auto_collection_cooldown`;
}

// Must mirror RedisClient.acquireLock("device:{id}"), which prepends `lock:` before zone-prefixing.
export function sagaLockKey(deviceId: string): string {
  return `lock:device:${deviceId}`;
}

export interface AutoCollectionCache {
  exists(key: string, jobId?: string): Promise<boolean>;
  get(key: string, jobId?: string): Promise<string | null>;
  setNxOwned(key: string, value: string, ttl: number, jobId?: string): Promise<boolean>;
  delete(key: string, jobId?: string): Promise<number>;
}

export interface AutoCollectionLogger {
  debug(message: string, context?: { jobId?: string }): Promise<void>;
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

export type EnqueueCollectionJob = (args: { deviceId: string; jobId?: string }) => Promise<boolean>;

export type ReadAtom = <T>(
  cache: AutoCollectionCache,
  key: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  options?: { jobId?: string },
) => Promise<T | null>;

export const AUTO_COLLECTION_CACHE = Symbol('AUTO_COLLECTION_CACHE');
export const AUTO_COLLECTION_ENQUEUE = Symbol('AUTO_COLLECTION_ENQUEUE');
export const AUTO_COLLECTION_READ_ATOM = Symbol('AUTO_COLLECTION_READ_ATOM');
export const AUTO_COLLECTION_LOGGER = Symbol('AUTO_COLLECTION_LOGGER');

@Injectable()
export class AutoCollectionService {
  constructor(
    @Inject(AUTO_COLLECTION_CACHE) private readonly cache: AutoCollectionCache,
    @Inject(AUTO_COLLECTION_ENQUEUE)
    private readonly enqueueCollectionJob: EnqueueCollectionJob,
    @Inject(AUTO_COLLECTION_READ_ATOM) private readonly readAtom: ReadAtom,
    @Inject(AUTO_COLLECTION_LOGGER) private readonly logger: AutoCollectionLogger,
  ) {}

  async maybeEnqueueCollectionOnRegister(deviceId: string, options: { jobId?: string } = {}): Promise<void> {
    const jobId = options.jobId ?? '';
    if (deviceId === NIL_DEVICE_ID) return;
    try {
      if (await this.cache.exists(sagaLockKey(deviceId), jobId)) {
        await this.logger.debug(`auto-collection skipped: saga lock held for device ${deviceId}`, { jobId });
        return;
      }
      const record = await this.readAtom<DeviceRecord>(this.cache, deviceRecord(deviceId), deviceRecordSchema, {
        jobId,
      });

      // no auto-collection during commissioning
      if (record !== null && record.role == null) {
        await this.logger.debug(`auto-collection skipped: device ${deviceId} is still commissioning (role=null)`, {
          jobId,
        });
        return;
      }
      const cooldownS =
        record !== null && !record.is_placeholder && record.status ? COOLDOWN_REFRESH_S : COOLDOWN_BOOTSTRAP_S;
      // setNxOwned with a per-call token (not strict setNx): a reconnect retry with a lost reply must not see its own just-set cooldown as "active"; a concurrent register's different token still loses.
      const acquired = await this.cache.setNxOwned(cooldownKey(deviceId), randomUUID(), cooldownS, jobId);
      if (!acquired) {
        await this.logger.debug(`auto-collection skipped: cooldown active for device ${deviceId}`, { jobId });
        return;
      }
      let enqueued: boolean;
      try {
        enqueued = await this.enqueueCollectionJob({ deviceId, jobId });
      } catch (exc) {
        await this.cache.delete(cooldownKey(deviceId), jobId);
        throw exc;
      }
      if (!enqueued) {
        await this.cache.delete(cooldownKey(deviceId), jobId);
        return;
      }
      await this.logger.info(
        `auto-enqueued collection for device ${deviceId} on agent register (cooldown=${cooldownS}s)`,
        { jobId },
      );
    } catch (exc) {
      await this.logger.warning(`auto-collection enqueue failed for device ${deviceId}: ${getErrorMessage(exc)}`, {
        jobId,
      });
    }
  }
}
