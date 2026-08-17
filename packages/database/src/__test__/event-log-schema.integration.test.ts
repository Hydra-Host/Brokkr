import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

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
});
