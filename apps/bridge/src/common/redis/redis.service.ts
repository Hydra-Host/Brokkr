import { Inject, Injectable, OnApplicationShutdown, Optional } from '@nestjs/common';

import { NIL_JOB_ID } from '../../constants';
import { logWarning } from '../../logger/logger.service';
import { getErrorMessage } from '../error-utils';

import {
  RedisClient,
  type RedisClientLogger,
  type RedisConfig,
  type RedisDriver,
  type RedisDriverFactory,
} from './redis-client';

export const REDIS_CONFIG = Symbol('REDIS_CONFIG');
export const REDIS_DRIVER_FACTORY = Symbol('REDIS_DRIVER_FACTORY');
export const REDIS_LOGGER = Symbol('REDIS_LOGGER');

@Injectable()
export class RedisService implements OnApplicationShutdown {
  private readonly client: RedisClient;

  constructor(
    @Inject(REDIS_CONFIG) private readonly config: RedisConfig,
    @Inject(REDIS_DRIVER_FACTORY) driverFactory: RedisDriverFactory,
    @Optional() @Inject(REDIS_LOGGER) logger?: RedisClientLogger,
  ) {
    this.client = new RedisClient(this.config, driverFactory, logger);
  }

  get connection(): RedisClient {
    return this.client;
  }

  async requireConnection(maxAttempts = 5, backoff = 3.0): Promise<void> {
    await this.client.requireConnection(maxAttempts, backoff);
  }

  async get(key: string, jobId?: string): Promise<string | null> {
    return this.client.get(key, jobId);
  }

  async set(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown> {
    return this.client.set(key, value, ttl, jobId);
  }

  async delete(key: string, jobId?: string): Promise<number> {
    return this.client.delete(key, jobId);
  }

  async exists(key: string, jobId?: string): Promise<boolean> {
    return this.client.exists(key, jobId);
  }

  async rpush(key: string, values: string[], jobId?: string): Promise<number> {
    return this.client.rpush(key, values, jobId);
  }

  async lrange(key: string, start: number, stop: number, jobId?: string): Promise<string[]> {
    return this.client.lrange(key, start, stop, jobId);
  }

  async expire(key: string, seconds: number, jobId?: string): Promise<boolean> {
    return this.client.expire(key, seconds, jobId);
  }

  async hset(key: string, mapping: Record<string, string>, ttl?: number, jobId?: string): Promise<number> {
    return this.client.hset(key, mapping, ttl, jobId);
  }

  async hget(key: string, field: string, jobId?: string): Promise<string | null> {
    return this.client.hget(key, field, jobId);
  }

  async hgetall(key: string, jobId?: string): Promise<Record<string, string>> {
    return this.client.hgetall(key, jobId);
  }

  async secretSet(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown> {
    return this.client.secretSet(key, value, ttl, jobId);
  }

  async secretGet(key: string, jobId?: string): Promise<string | null> {
    return this.client.secretGet(key, jobId);
  }

  async secretHset(key: string, mapping: Record<string, string>, ttl?: number, jobId?: string): Promise<number> {
    return this.client.secretHset(key, mapping, ttl, jobId);
  }

  async secretHget(key: string, field: string, jobId?: string): Promise<string | null> {
    return this.client.secretHget(key, field, jobId);
  }

  async scan(pattern: string, jobId?: string): Promise<string[]> {
    return this.client.scan(pattern, jobId);
  }

  async setNx(key: string, value: string, ttl?: number, jobId?: string): Promise<boolean> {
    return this.client.setNx(key, value, ttl, jobId);
  }

  async setNxOwned(key: string, value: string, ttl: number, jobId?: string): Promise<boolean> {
    return this.client.setNxOwned(key, value, ttl, jobId);
  }

  async renewIfOwner(key: string, expectedValue: string, ttl: number, jobId?: string): Promise<boolean> {
    return this.client.renewIfOwner(key, expectedValue, ttl, jobId);
  }

  async renewLockIfOwner(lockKey: string, expectedValue: string, ttl: number, jobId?: string): Promise<boolean> {
    return this.client.renewLockIfOwner(lockKey, expectedValue, ttl, jobId);
  }

  async deleteIfOwner(key: string, expectedValue: string, jobId?: string): Promise<boolean> {
    return this.client.deleteIfOwner(key, expectedValue, jobId);
  }

  async acquireLock(
    lockKey: string,
    timeout = 300,
    jobId?: string,
    holderInfo?: Record<string, string>,
  ): Promise<string | null> {
    return this.client.acquireLock(lockKey, timeout, jobId, holderInfo);
  }

  async releaseLock(lockKey: string, token: string, jobId?: string): Promise<boolean> {
    return this.client.releaseLock(lockKey, token, jobId);
  }

  async readLockInfo(lockKey: string, jobId?: string): Promise<Record<string, string> | null> {
    return this.client.readLockInfo(lockKey, jobId);
  }

  async waitForLockRelease(lockKey: string, timeout = 300, pollInterval = 2.0, jobId?: string): Promise<boolean> {
    return this.client.waitForLockRelease(lockKey, timeout, pollInterval, jobId);
  }

  async ping(jobId?: string): Promise<boolean> {
    return this.client.ping(jobId);
  }

  async close(jobId?: string): Promise<void> {
    await this.client.close(jobId);
  }

  // Close in onApplicationShutdown, not onModuleDestroy: leader-election cleanup must find the connection still open (pinned by leader-election-shutdown-order.spec).
  async onApplicationShutdown(): Promise<void> {
    // fail-soft: a throw would abort the remaining shutdown sweep, stranding other holders' closers.
    try {
      await this.close();
    } catch (error) {
      void logWarning(`Redis close failed during shutdown: ${getErrorMessage(error)}`, { jobId: NIL_JOB_ID });
    }
  }
}

export type { RedisConfig, RedisDriver, RedisDriverFactory };
