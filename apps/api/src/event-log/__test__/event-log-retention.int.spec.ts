import type { ConfigService } from '@nestjs/config';
import { createPrismaClientOptions, type Prisma } from '@repo/database';
import { randomUUID } from 'crypto';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BATCH_SIZE, DEFAULT_RETENTION_DAYS, EventLogRetentionCron } from '../event-log-retention.cron';

const connectionString = process.env.DATABASE_URL;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const SEED_CHUNK = 1_000;

const batchesFor = (expired: number): number => Math.floor(expired / BATCH_SIZE) + 1;

describe.skipIf(!connectionString)('event-log retention (integration, live DB)', () => {
  let prisma: PrismaClient;
  let cron: EventLogRetentionCron;

  const organizationId = randomUUID();
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const executeRawCalls: string[] = [];

  const cutoff = new Date(Date.now() - DEFAULT_RETENTION_DAYS * DAY_MS);
  const expiredAt = new Date(cutoff.getTime() - HOUR_MS);
  const retainedAt = new Date(Date.now() - DAY_MS);

  const hourOf = (at: Date): Date => new Date(Math.floor(at.getTime() / HOUR_MS) * HOUR_MS);

  const seededExpiredEvents = BATCH_SIZE + 1;
  const seededExpiredBuckets = 2;
  let foreignExpiredEvents = 0;
  let foreignExpiredBuckets = 0;
  let skipReason = '';

  const retainedEventIds: string[] = [];
  let retainedBucketId = '';

  const eventRow = (createdAt: Date): Prisma.EventLogCreateManyInput => ({
    organizationId,
    tier: 'ACTIVITY',
    durability: 'BEST_EFFORT',
    resource: 'device',
    action: 'update',
    actionKey: 'device.update',
    actorType: 'UI',
    outcome: 'SUCCEEDED',
    createdAt,
  });

  beforeAll(async () => {
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));

    foreignExpiredEvents = await prisma.eventLog.count({ where: { createdAt: { lt: cutoff } } });
    foreignExpiredBuckets = await prisma.eventLogAccessBucket.count({ where: { createdAt: { lt: cutoff } } });

    if (foreignExpiredEvents > 0 || foreignExpiredBuckets > 0) {
      skipReason =
        `refusing to run the global retention prune: this database already holds ${foreignExpiredEvents} event log rows ` +
        `+ ${foreignExpiredBuckets} access buckets past the retention window that this fixture did not create, and the ` +
        `cron would delete them irreversibly`;
      return;
    }

    const expiredRows = Array.from({ length: seededExpiredEvents }, () => eventRow(expiredAt));
    for (let offset = 0; offset < expiredRows.length; offset += SEED_CHUNK) {
      await prisma.eventLog.createMany({ data: expiredRows.slice(offset, offset + SEED_CHUNK) });
    }

    for (let i = 0; i < 3; i += 1) {
      const row = await prisma.eventLog.create({ data: eventRow(retainedAt) });
      retainedEventIds.push(row.id);
    }

    await prisma.eventLogAccessBucket.createMany({
      data: [
        { organizationId, actorKey: 'user:expired-1', hourBucket: hourOf(expiredAt), createdAt: expiredAt },
        { organizationId, actorKey: 'user:expired-2', hourBucket: hourOf(expiredAt), createdAt: expiredAt },
      ],
    });
    const bucket = await prisma.eventLogAccessBucket.create({
      data: { organizationId, actorKey: 'user:retained', hourBucket: hourOf(retainedAt), createdAt: retainedAt },
    });
    retainedBucketId = bucket.id;

    const tracked = {
      $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => {
        const table = values.find(
          (value): value is { strings: string[] } => typeof value === 'object' && value !== null && 'strings' in value,
        );
        executeRawCalls.push(table ? table.strings.join('') : '');
        return prisma.$executeRaw(query, ...values);
      },
      eventLog: prisma.eventLog,
      eventLogAccessBucket: prisma.eventLogAccessBucket,
    };
    const configService = { get: () => undefined };
    cron = new EventLogRetentionCron(
      tracked as unknown as PrismaClient,
      configService as unknown as ConfigService,
      logger as never,
    );

    await cron.pruneExpiredEvents();
  }, 180_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.eventLogAccessBucket.deleteMany({ where: { organizationId } });
    await prisma.$disconnect();
  });

  it('deletes every event log row older than the window', async (ctx) => {
    if (skipReason) ctx.skip(skipReason);

    await expect(prisma.eventLog.count({ where: { organizationId, createdAt: { lt: cutoff } } })).resolves.toBe(0);
  });

  it('keeps exactly the event log rows inside the window', async (ctx) => {
    if (skipReason) ctx.skip(skipReason);

    const rows = await prisma.eventLog.findMany({ where: { organizationId }, select: { id: true } });
    expect(rows.map((row) => row.id).sort()).toEqual([...retainedEventIds].sort());
  });

  it('prunes the access buckets on the same tick and keeps the ones inside the window', async (ctx) => {
    if (skipReason) ctx.skip(skipReason);

    const buckets = await prisma.eventLogAccessBucket.findMany({ where: { organizationId }, select: { id: true } });
    expect(buckets).toEqual([{ id: retainedBucketId }]);
  });

  it('seeds a backlog that cannot be drained by a single batch', (ctx) => {
    if (skipReason) ctx.skip(skipReason);

    expect(batchesFor(foreignExpiredEvents + seededExpiredEvents)).toBeGreaterThan(1);
  });

  it('spans the backlog with full batches plus one short batch, then stops', (ctx) => {
    if (skipReason) ctx.skip(skipReason);

    const eventBatches = batchesFor(foreignExpiredEvents + seededExpiredEvents);
    const bucketBatches = batchesFor(foreignExpiredBuckets + seededExpiredBuckets);
    expect(executeRawCalls).toEqual([
      ...Array.from({ length: eventBatches }, () => '"EventLog"'),
      ...Array.from({ length: bucketBatches }, () => '"EventLogAccessBucket"'),
    ]);
  });

  it('reports the pruned totals and no backlog', (ctx) => {
    if (skipReason) ctx.skip(skipReason);

    expect(logger.log).toHaveBeenCalledWith(
      `Purged ${foreignExpiredEvents + seededExpiredEvents} event log rows + ${foreignExpiredBuckets + seededExpiredBuckets} access buckets older than ${DEFAULT_RETENTION_DAYS} days`,
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
