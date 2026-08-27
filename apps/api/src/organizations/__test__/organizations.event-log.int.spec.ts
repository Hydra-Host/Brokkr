import { Reflector } from '@nestjs/core';
import { createPrismaClientOptions } from '@repo/database';
import { randomUUID } from 'crypto';
import { from } from 'rxjs';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { SingleSupplyTenancyPolicy } from 'src/common/authz/supply-tenancy-policy';
import { ContextService } from 'src/common/context/context.service';
import { EventLogInterceptor } from 'src/event-log/event-log.interceptor';
import { EventLogRepository } from 'src/event-log/event-log.repository';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrganizationsController } from '../organizations.controller';
import { OrganizationsRepository } from '../organizations.repository';
import { OrganizationsService } from '../organizations.service';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('organization settings event capture (integration, live DB)', () => {
  let prisma: PrismaClient;
  let contextService: ContextService;
  let repository: OrganizationsRepository;
  let organizationId: string;
  let organizationName: string;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  function identity(permissions: string[] = ['organization:update']): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Owner',
      organizationId,
      organization: { id: organizationId },
      permissions: new Set(permissions),
      session: { user: { id: 'u-int-1', email: 'int@example.com' } },
    } as unknown as IdentityContext;
  }

  const realEventLog = () => new EventLogService(new EventLogRepository(prisma), logger as never, contextService);

  const throwingEventLog = () =>
    ({
      recordInTransaction: vi.fn().mockRejectedValue(new Error('event write failed')),
    }) as unknown as EventLogService;

  function buildService(eventLog: EventLogService) {
    return new OrganizationsService(
      repository,
      { create: vi.fn() } as never,
      { emit: vi.fn() } as never,
      contextService,
      null as never,
      { getAllowedOrgTypes: () => [] } as never,
      { resolveEffectivePermissions: vi.fn() } as never,
      prisma,
      eventLog,
      logger as never,
    );
  }

  const runInContext = <T>(fn: () => Promise<T>, permissions?: string[]): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run(
        {
          requestId: `req-${randomUUID()}`,
          identity: identity(permissions),
          method: 'PATCH',
          path: '/api/v1/organizations',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          fn().then(resolve, reject);
        },
      );
    });

  const eventsFor = (targetId: string) =>
    prisma.eventLog.findMany({ where: { organizationId, targetId }, orderBy: { createdAt: 'asc' } });

  const currentName = async () =>
    (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { name: true } })).name;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function settledRowsFor(requestId: string) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await prisma.eventLog.findMany({ where: { organizationId, requestId } });
      if (rows.length > 0) {
        await sleep(150);
        return prisma.eventLog.findMany({ where: { organizationId, requestId } });
      }
      await sleep(20);
    }
    return [];
  }

  async function throughInterceptor(eventLog: EventLogService, name: string, permissions?: string[]): Promise<string> {
    const service = buildService(eventLog);
    const interceptor = new EventLogInterceptor(contextService, realEventLog(), new Reflector(), logger as never);
    const requestId = `req-${randomUUID()}`;
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'PATCH',
          path: '/api/v1/organizations',
          params: {},
          ip: '203.0.113.9',
          headers: { 'user-agent': 'vitest' },
        }),
      }),
      getHandler: () => OrganizationsController.prototype.update,
    };

    await new Promise<void>((resolve) => {
      contextService.run(
        {
          requestId,
          identity: identity(permissions),
          method: 'PATCH',
          path: '/api/v1/organizations',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          interceptor
            .intercept(executionContext as never, { handle: () => from(service.update({ name })) })
            .subscribe({ error: () => resolve(), complete: () => resolve() });
        },
      );
    });

    return requestId;
  }

  beforeAll(async () => {
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    contextService = new ContextService(new DesignationOperatorPolicy());
    repository = new OrganizationsRepository(prisma, new SingleSupplyTenancyPolicy());

    organizationName = `it-evlog-org-${randomUUID()}`;
    const org = await prisma.organization.create({
      data: { name: organizationName, tenantType: 'DemandCustomer', country: 'US' },
    });
    organizationId = org.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  it('persists an atomic evidence row alongside the settings update', async () => {
    const before = await currentName();
    const service = buildService(realEventLog());

    await runInContext(() => service.update({ name: `it-renamed-${randomUUID().slice(0, 8)}` }));

    const rows = await eventsFor(organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource: 'organization',
      action: 'updated',
      actionKey: 'organization.settings-updated',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      outcome: 'SUCCEEDED',
      targetId: organizationId,
      targetLabel: before,
      actorId: 'u-int-1',
      actorLabel: 'int@example.com',
      method: 'PATCH',
      path: '/api/v1/organizations',
    });
    expect(rows[0].metadata).toEqual({ changedFields: ['name'] });
    await prisma.eventLog.deleteMany({ where: { organizationId } });
  });

  it('records the changed field names and none of the submitted values', async () => {
    const canary = `zz-canary-${randomUUID().replace(/-/g, '')}`;
    const service = buildService(realEventLog());

    await runInContext(() =>
      service.update({ name: canary, email: `${canary}@example.com`, metadata: `{"vatId":"${canary}"}` }),
    );

    const rows = await eventsFor(organizationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toEqual({ changedFields: ['name', 'email', 'metadata'] });
    expect(JSON.stringify(rows[0])).not.toContain(canary);
    await prisma.eventLog.deleteMany({ where: { organizationId } });
  });

  it('rolls the settings update back when the event write fails', async () => {
    const before = await currentName();
    const service = buildService(throwingEventLog());

    await expect(runInContext(() => service.update({ name: `it-rolled-${randomUUID().slice(0, 8)}` }))).rejects.toThrow(
      'event write failed',
    );

    expect(await currentName()).toBe(before);
    expect(await eventsFor(organizationId)).toEqual([]);
  });

  it('falls back to a tier 2 failure row carrying the tier 1 action key when the mutation rolls back', async () => {
    const before = await currentName();

    const requestId = await throughInterceptor(throwingEventLog(), `it-tier2-${randomUUID().slice(0, 8)}`);

    const rows = await settledRowsFor(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      resource: 'organization',
      action: 'update',
      actionKey: 'organization.settings-updated',
      tier: 'ACTIVITY',
      durability: 'BEST_EFFORT',
      outcome: 'FAILED',
    });
    expect(await currentName()).toBe(before);
    await prisma.eventLog.deleteMany({ where: { organizationId } });
  });

  it('records a denied update under the same action key a success emits', async () => {
    const before = await currentName();

    const requestId = await throughInterceptor(realEventLog(), `it-denied-${randomUUID().slice(0, 8)}`, []);

    const rows = await settledRowsFor(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actionKey: 'organization.settings-updated',
      outcome: 'DENIED',
      tier: 'ACTIVITY',
    });
    expect(await currentName()).toBe(before);
    await prisma.eventLog.deleteMany({ where: { organizationId } });
  });

  it('writes exactly one row for a successful update, with no tier 2 duplicate', async () => {
    const requestId = await throughInterceptor(realEventLog(), `it-once-${randomUUID().slice(0, 8)}`);

    const rows = await settledRowsFor(requestId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actionKey: 'organization.settings-updated', tier: 'EVIDENCE' });
    expect(rows.filter((row) => row.tier === 'ACTIVITY')).toEqual([]);
    await prisma.eventLog.deleteMany({ where: { organizationId } });
  });
});
