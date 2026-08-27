import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';

export const DEFAULT_RETENTION_DAYS = 365;
export const BATCH_SIZE = 10_000;
export const MAX_BATCHES_PER_TABLE = 100;

const POSITIVE_INTEGER = /^[1-9]\d*$/;

/** Shared with the export route: a cursor is expired exactly when it predates what this cron keeps. */
export function resolveRetentionDays(configService: ConfigService): number {
  const configured = configService.get<string>('EVENT_LOG_RETENTION_DAYS') ?? '';
  // Strict pattern, not parseInt: parseInt('1.5') is 1, so a typo would purge a year of history.
  return POSITIVE_INTEGER.test(configured) ? parseInt(configured, 10) : DEFAULT_RETENTION_DAYS;
}

const EVENT_LOG_TABLE = Prisma.sql`"EventLog"`;
const ACCESS_BUCKET_TABLE = Prisma.sql`"EventLogAccessBucket"`;

interface PruneResult {
  deleted: number;
  remaining: number;
}

/** Each table gets its own BATCH_SIZE * MAX_BATCHES_PER_TABLE budget per tick, so the guarantee is
 *  monotonic progress — a backlog drains over successive nights, steady state holds the window. */
@Injectable()
export class EventLogRetentionCron {
  private readonly retentionDays: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly configService: ConfigService,
    @Logger(EventLogRetentionCron.name) private readonly logger: LoggerService,
  ) {
    this.retentionDays = resolveRetentionDays(this.configService);
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'event-log-retention' })
  async pruneExpiredEvents(): Promise<void> {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60 * 1000);

    try {
      const events = await this.pruneInBatches(EVENT_LOG_TABLE, cutoff, () =>
        this.prisma.eventLog.count({ where: { createdAt: { lt: cutoff } } }),
      );
      const buckets = await this.pruneInBatches(ACCESS_BUCKET_TABLE, cutoff, () =>
        this.prisma.eventLogAccessBucket.count({ where: { createdAt: { lt: cutoff } } }),
      );

      if (events.deleted + buckets.deleted > 0) {
        this.logger.log(
          `Purged ${events.deleted} event log rows + ${buckets.deleted} access buckets older than ${this.retentionDays} days`,
        );
      }
      if (events.remaining + buckets.remaining > 0) {
        this.logger.warn(
          `Event log retention hit its per-table batch cap; ${events.remaining} event log rows + ${buckets.remaining} access buckets remain older than ${this.retentionDays} days`,
        );
      }
    } catch (error) {
      this.logger.error(`Event log retention cleanup failed: ${getErrorMessage(error)}`);
    }
  }

  // Deliberate tier drop: batching bounds lock duration and table bloat, and hand-written SQL is
  // what lets the schema test EXPLAIN the exact statement that ships on this destructive path.
  private async pruneInBatches(
    table: Prisma.Sql,
    cutoff: Date,
    countRemaining: () => Promise<number>,
  ): Promise<PruneResult> {
    let deleted = 0;

    for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
      const removed = await this.prisma.$executeRaw`
        DELETE FROM ${table}
        WHERE id IN (SELECT id FROM ${table} WHERE "createdAt" < ${cutoff} LIMIT ${BATCH_SIZE})
      `;
      deleted += removed;
      // Known limit of running unlocked: a concurrent replica taking part of the batch also reads as
      // short, so this exits early and reports `remaining: 0` while expired rows are still there.
      if (removed < BATCH_SIZE) return { deleted, remaining: 0 };
    }

    return { deleted, remaining: await countRemaining() };
  }
}
