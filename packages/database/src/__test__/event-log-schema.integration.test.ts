import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, Prisma, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

const organizationId = '00000000-0000-0000-0000-0000000000e1';

describe.skipIf(!connectionString)('EventLog schema', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: connectionString! });
  });

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.eventLogAccessBucket.deleteMany({ where: { organizationId } });
    await prisma.$disconnect();
  });

  it('persists a system-actor event with no actorId', async () => {
    const row = await prisma.eventLog.create({
      data: {
        organizationId,
        tier: 'ACTIVITY',
        durability: 'BEST_EFFORT',
        resource: 'device',
        action: 'update',
        actionKey: 'device.update',
        actorType: 'SYSTEM',
        outcome: 'SUCCEEDED',
      },
    });

    expect(row.actorId).toBeNull();
    expect(row.actorType).toBe('SYSTEM');
    expect(row.durability).toBe('BEST_EFFORT');
  });

  it('persists an api-key actor with the owning user and the key label', async () => {
    const row = await prisma.eventLog.create({
      data: {
        organizationId,
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        resource: 'api-key',
        action: 'revoked',
        actionKey: 'api-key.revoked',
        actorType: 'API',
        actorId: 'owner-user-id',
        actorLabel: 'ed@example.com',
        apiKeyId: 'key-1',
        apiKeyLabel: 'ci-bot',
        outcome: 'SUCCEEDED',
      },
    });

    expect(row.actorId).toBe('owner-user-id');
    expect(row.apiKeyLabel).toBe('ci-bot');
  });

  it('records a denied outcome with an error code', async () => {
    const row = await prisma.eventLog.create({
      data: {
        organizationId,
        tier: 'ACTIVITY',
        durability: 'BEST_EFFORT',
        resource: 'event-log',
        action: 'access',
        actionKey: 'event-log.access',
        actorType: 'UI',
        outcome: 'DENIED',
        errorCode: '403:ForbiddenException',
      },
    });

    expect(row.outcome).toBe('DENIED');
    expect(row.errorCode).toBe('403:ForbiddenException');
  });

  it('rejects a second access bucket for the same actor and hour', async () => {
    const hourBucket = new Date('2026-07-28T10:00:00.000Z');
    await prisma.eventLogAccessBucket.create({
      data: { organizationId, actorKey: 'user:abc', hourBucket },
    });

    await expect(
      prisma.eventLogAccessBucket.create({
        data: { organizationId, actorKey: 'user:abc', hourBucket },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects an access bucket whose hour is not truncated', async () => {
    await expect(
      prisma.eventLogAccessBucket.create({
        data: { organizationId, actorKey: 'user:misaligned', hourBucket: new Date('2026-07-28T10:30:00.000Z') },
      }),
    ).rejects.toThrow();
  });

  it('rejects sub-second precision in an access bucket hour', async () => {
    await expect(
      prisma.eventLogAccessBucket.create({
        data: { organizationId, actorKey: 'user:millis', hourBucket: new Date('2026-07-28T10:00:00.123Z') },
      }),
    ).rejects.toThrow();
  });

  it('allows two api keys of one user to hold separate buckets', async () => {
    const hourBucket = new Date('2026-07-28T11:00:00.000Z');
    await prisma.eventLogAccessBucket.create({
      data: { organizationId, actorKey: 'api-key:key-a', hourBucket },
    });
    const second = await prisma.eventLogAccessBucket.create({
      data: { organizationId, actorKey: 'api-key:key-b', hourBucket },
    });

    expect(second.actorKey).toBe('api-key:key-b');
  });

  it('defines the ascending composite export index', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'EventLog'
    `;

    expect(rows.map((row) => row.indexname)).toContain('EventLog_org_createdAt_id_asc_idx');
  });

  it('defines the descending composite export index', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'EventLog'
    `;

    expect(rows.map((row) => row.indexname)).toContain('EventLog_org_createdAt_id_desc_idx');
  });

  it('leads the event log retention index with createdAt, not organizationId', async () => {
    const rows = await retentionIndex('EventLog_createdAt_id_desc_idx');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/USING btree \("createdAt" DESC, id DESC\)$/);
  });

  it('leads the access bucket retention index with createdAt', async () => {
    const rows = await retentionIndex('EventLogAccessBucket_createdAt_idx');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.indexdef).toMatch(/USING btree \("createdAt"\)$/);
  });

  it('marks the event log retention index valid, not a leftover from a failed concurrent build', async () => {
    const rows = await retentionIndex('EventLog_createdAt_id_desc_idx');

    expect(rows[0]?.valid).toBe(true);
  });

  it('marks the access bucket retention index valid, not a leftover from a failed concurrent build', async () => {
    const rows = await retentionIndex('EventLogAccessBucket_createdAt_idx');

    expect(rows[0]?.valid).toBe(true);
  });

  it('plans the event log retention delete on the createdAt index when an index is available', async () => {
    const plan = await explainRetentionDelete('EventLog');

    expect(plan).toContain('"EventLog_createdAt_id_desc_idx"');
    expect(plan).not.toMatch(/Seq Scan on "EventLog"/);
  });

  it('plans the access bucket retention delete on the createdAt index when an index is available', async () => {
    const plan = await explainRetentionDelete('EventLogAccessBucket');

    expect(plan).toContain('"EventLogAccessBucket_createdAt_idx"');
    expect(plan).not.toMatch(/Seq Scan on "EventLogAccessBucket"/);
  });

  function retentionIndex(indexname: string): Promise<Array<{ indexdef: string; valid: boolean }>> {
    return prisma.$queryRaw<Array<{ indexdef: string; valid: boolean }>>`
      SELECT pg_get_indexdef(i.indexrelid) AS indexdef, i.indisvalid AS valid
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = ${indexname}
    `;
  }

  async function explainRetentionDelete(table: 'EventLog' | 'EventLogAccessBucket'): Promise<string> {
    const cutoff = new Date('2025-01-01T00:00:00.000Z');
    const statement =
      table === 'EventLog'
        ? Prisma.sql`EXPLAIN DELETE FROM "EventLog"
            WHERE id IN (SELECT id FROM "EventLog" WHERE "createdAt" < ${cutoff} LIMIT 10000)`
        : Prisma.sql`EXPLAIN DELETE FROM "EventLogAccessBucket"
            WHERE id IN (SELECT id FROM "EventLogAccessBucket" WHERE "createdAt" < ${cutoff} LIMIT 10000)`;

    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL enable_seqscan = off');
      const rows = await tx.$queryRaw<Array<Record<string, string>>>(statement);
      return rows.map((row) => Object.values(row).join(' ')).join('\n');
    });
  }
  it('defines the cross-organization actionKey index', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'EventLog'
    `;

    expect(rows.map((row) => row.indexname)).toContain('EventLog_actionKey_createdAt_id_desc_idx');
  });

  it('leads the cross-organization actionKey index with actionKey, not organizationId', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexdef: string }>>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'EventLog' AND indexname = 'EventLog_actionKey_createdAt_id_desc_idx'
    `;

    expect(rows[0]?.indexdef).toContain('("actionKey", "createdAt" DESC, id DESC)');
  });
});
