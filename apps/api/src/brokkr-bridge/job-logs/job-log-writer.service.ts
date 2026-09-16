import { Inject, Injectable } from '@nestjs/common';
import { JobType } from '@repo/database';
import { SYSTEM_JOB_SAGAS } from '@repo/lifecycle';
import { type Redis } from 'ioredis';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { REDIS_CLIENT } from 'src/common/redis';
import { REDIS_KEYS } from 'src/common/redis/redis-keys';
import { LoggerService } from 'src/logger/logger.service';

export const JOB_LOG_TTL_SECONDS = 2_592_000;
export const JOB_LOG_MAX_STREAM_ENTRIES = 10_000;

export const JOB_LOG_SUPPRESSED_PLAN_ID_PREFIXES: readonly string[] = ['health-cron-', 'heartbeat-'];

/** System inventory collection runs hourly per device and its lifecycle row id carries no prefix, so suppression keys on the saga. */
export const JOB_LOG_SUPPRESSED_SAGAS: readonly string[] = [SYSTEM_JOB_SAGAS[JobType.InventoryCollection]];

export type JobLogLevel = 'debug' | 'info' | 'warning' | 'error';

export function isJobLogSuppressed(planId: string, sagaName?: string): boolean {
  if (sagaName !== undefined && JOB_LOG_SUPPRESSED_SAGAS.includes(sagaName)) return true;
  return JOB_LOG_SUPPRESSED_PLAN_ID_PREFIXES.some((prefix) => planId.startsWith(prefix));
}

@Injectable()
export class JobLogWriterService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Logger(JobLogWriterService.name) private readonly logger: LoggerService,
  ) {}

  async write(
    zoneId: string,
    planId: string,
    level: JobLogLevel,
    message: string,
    appClassName: string,
    sagaName?: string,
  ): Promise<void> {
    if (isJobLogSuppressed(planId, sagaName)) return;
    try {
      const key = REDIS_KEYS.jobLogs(zoneId, planId);
      await this.redis.xadd(
        key,
        'MAXLEN',
        '~',
        JOB_LOG_MAX_STREAM_ENTRIES,
        '*',
        'timestamp',
        new Date().toISOString(),
        'log_level',
        level,
        'message',
        message,
        'app_name',
        'brokkr-hub',
        'app_class_name',
        appClassName,
      );
      await this.redis.expire(key, JOB_LOG_TTL_SECONDS);
    } catch (error) {
      this.logger.warn(`Failed to write job log: ${getErrorMessage(error)}`, planId);
    }
  }
}
