import { ForbiddenException } from '@nestjs/common';
import { EventLogQuerySchema, type EventLogQuery } from '@repo/api-client';
import { createPrismaClientOptions } from '@repo/database';
import { randomUUID } from 'crypto';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventLogRepository } from '../event-log.repository';
import { EventLogService } from '../event-log.service';
import type { EventLogWrite } from '../event-log.types';

const connectionString = process.env.DATABASE_URL;
const q = (overrides: Partial<EventLogQuery> = {}): EventLogQuery => ({ page: 1, ...overrides });

describe.skipIf(!connectionString)('event-log browse (integration, live DB)', () => {
  let prisma: PrismaClient;
  let contextService: ContextService;
  let service: EventLogService;
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  function identity(permissions: string[], org = organizationId): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Admin',
      organizationId: org,
      organization: { id: org },
      permissions: new Set(permissions),
      session: { user: { id: 'u-browse', email: 'browse@example.com' } },
    } as unknown as IdentityContext;
  }

  const runAs = <T>(permissions: string[], fn: () => Promise<T>, org = organizationId): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run({ requestId: `req-${randomUUID()}`, identity: identity(permissions, org) }, () => {
        fn().then(resolve, reject);
      });
    });

  const seed = (overrides: Partial<EventLogWrite> & { createdAt?: Date }) => {
    const { createdAt, ...write } = overrides;
    return prisma.eventLog.create({
      data: {
        organizationId,
        tier: 'ACTIVITY',
        durability: 'BEST_EFFORT',
        resource: 'device',
        action: 'update',
        actionKey: 'device.update',
        actorType: 'UI',
        outcome: 'SUCCEEDED',
        ...write,
        ...(createdAt ? { createdAt } : {}),
      },
    });
  };

  beforeAll(async () => {
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    contextService = new ContextService(new DesignationOperatorPolicy());
    service = new EventLogService(new EventLogRepository(prisma), logger as never, contextService);

    await seed({
      actionKey: 'member.removed',
      resource: 'member',
      action: 'removed',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      targetId: 'm-1',
      actorLabel: 'admin@example.com',
      createdAt: new Date('2026-08-01T10:00:00.000Z'),
    });
    await seed({
      actionKey: 'device.power-control',
      action: 'power-control',
      createdAt: new Date('2026-08-02T10:00:00.000Z'),
    });
    await seed({
      actionKey: 'prefix.create',
      resource: 'prefix',
      action: 'create',
      actorType: 'SYSTEM',
      actorId: null,
      createdAt: new Date('2026-08-03T10:00:00.000Z'),
    });
    await seed({ actionKey: 'device.update', outcome: 'DENIED', createdAt: new Date('2026-08-04T10:00:00.000Z') });
    await prisma.eventLog.create({
      data: {
        organizationId: otherOrganizationId,
        tier: 'ACTIVITY',
        durability: 'BEST_EFFORT',
        resource: 'device',
        action: 'update',
        actionKey: 'other.org.event',
        actorType: 'UI',
        outcome: 'SUCCEEDED',
      },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId: { in: [organizationId, otherOrganizationId] } } });
    await prisma.$disconnect();
  });

  it('rejects a caller without event-log access', async () => {
    await expect(runAs([], () => service.list(q()))).rejects.toThrow(ForbiddenException);
  });

  it('returns only the calling organization rows, newest first', async () => {
    const page = await runAs(['event-log:access'], () => service.list(q()));

    expect(page.data.map((row) => row.actionKey)).toEqual(['device.update', 'device.power-control', 'member.removed']);
    expect(page.data.every((row) => row.actionKey !== 'other.org.event')).toBe(true);
  });

  it('never leaks another organization even when the query asks for it', async () => {
    const page = await runAs(['event-log:access'], () =>
      service.list(q({ organizationId: otherOrganizationId } as never)),
    );

    expect(page.data.every((row) => row.actionKey !== 'other.org.event')).toBe(true);
  });

  it('hides system actors by default and reveals them on request', async () => {
    const hidden = await runAs(['event-log:access'], () => service.list(q()));
    const shown = await runAs(['event-log:access'], () => service.list(q({ includeSystemActors: true })));

    expect(hidden.data.map((row) => row.actionKey)).not.toContain('prefix.create');
    expect(shown.data.map((row) => row.actionKey)).toContain('prefix.create');
  });

  it('treats an explicit includeSystemActors=false as an exclusion', async () => {
    const parsed = EventLogQuerySchema.parse({ page: 1, includeSystemActors: 'false' });
    const page = await runAs(['event-log:access'], () => service.list(parsed));

    expect(page.data.map((row) => row.actionKey)).not.toContain('prefix.create');
  });

  it('filters by action key', async () => {
    const page = await runAs(['event-log:access'], () => service.list(q({ actionKey: 'member.removed' })));

    expect(page.data).toHaveLength(1);
    expect(page.data[0].targetId).toBe('m-1');
  });

  it('filters by tier and durability', async () => {
    const page = await runAs(['event-log:access'], () => service.list(q({ tier: 'EVIDENCE', durability: 'ATOMIC' })));

    expect(page.data.map((row) => row.actionKey)).toEqual(['member.removed']);
  });

  it('filters by outcome', async () => {
    const page = await runAs(['event-log:access'], () => service.list(q({ outcome: 'DENIED' })));

    expect(page.data).toHaveLength(1);
    expect(page.data[0].outcome).toBe('DENIED');
  });

  it('filters by a createdAt window', async () => {
    const page = await runAs(['event-log:access'], () =>
      service.list(q({ from: new Date('2026-08-02T00:00:00.000Z'), to: new Date('2026-08-02T23:59:59.000Z') })),
    );

    expect(page.data.map((row) => row.actionKey)).toEqual(['device.power-control']);
  });

  it('paginates with stable ordering across pages', async () => {
    const first = await runAs(['event-log:access'], () => service.list(q({ page: 1, pageSize: 2 })));
    const second = await runAs(['event-log:access'], () => service.list(q({ page: 2, pageSize: 2 })));

    expect(first.data).toHaveLength(2);
    expect(first.meta.totalItems).toBe(3);
    const ids = [...first.data, ...second.data].map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('returns metadata as an object and never as a raw json scalar', async () => {
    await seed({ actionKey: 'role.permissions-changed', metadata: { grantedKeys: ['device:read'] } });

    const page = await runAs(['event-log:access'], () => service.list(q({ actionKey: 'role.permissions-changed' })));

    expect(page.data[0].metadata).toEqual({ grantedKeys: ['device:read'] });
  });
});
