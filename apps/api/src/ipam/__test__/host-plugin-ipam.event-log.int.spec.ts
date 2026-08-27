import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { EventLogQuery } from '@repo/api-client';
import { createPrismaClientOptions } from '@repo/database';
import { randomUUID } from 'crypto';
import { from } from 'rxjs';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { EventLogSystemFinalizer } from 'src/event-log/event-log-system.finalizer';
import { EventLogInterceptor } from 'src/event-log/event-log.interceptor';
import { EventLogRepository } from 'src/event-log/event-log.repository';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostPluginIpamProvisioning } from '../host-plugin-ipam-provisioning';
import { IpamRoleRepository } from '../ipam-role/ipam-role.repository';
import { PrefixRepository } from '../prefix/prefix.repository';
import { PrefixService } from '../prefix/prefix.service';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('system event capture for plugin IPAM writes (integration, live DB)', () => {
  let prisma: PrismaClient;
  let contextService: ContextService;
  let eventLog: EventLogService;
  let hostPlugin: HostPluginIpamProvisioning;
  let organizationId: string;
  let zoneId: string;
  let prefixRoleId: string;
  let createdPrefixRole = false;
  let octet = 0;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const dhcpPublisher = { republishOne: vi.fn().mockResolvedValue(true) };

  const nextPrefix = () => `10.99.${octet++}.0/24`;

  function identity(permissions: string[]): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Admin',
      organizationId,
      organization: { id: organizationId },
      permissions: new Set(permissions),
      session: { user: { id: 'u-int-sys', email: 'sys@example.com' } },
    } as unknown as IdentityContext;
  }

  const runInRequest = <T>(requestId: string, permissions: string[], fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run({ requestId, identity: identity(permissions) }, () => {
        fn().then(resolve, reject);
      });
    });

  const rowsForOrg = () => prisma.eventLog.findMany({ where: { organizationId }, orderBy: { createdAt: 'asc' } });

  const rowsForRequest = (requestId: string) =>
    prisma.eventLog.findMany({ where: { organizationId, requestId }, orderBy: { createdAt: 'asc' } });

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function settledRowsFor(requestId: string, expected: number) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await rowsForRequest(requestId);
      if (rows.length >= expected) {
        await sleep(150);
        return rowsForRequest(requestId);
      }
      await sleep(20);
    }
    return rowsForRequest(requestId);
  }

  function createPrefixThroughPlugin(overrides: { zoneId?: string; prefix?: string } = {}) {
    return hostPlugin.createPrefix({
      organizationId,
      zoneId: overrides.zoneId ?? zoneId,
      prefix: overrides.prefix ?? nextPrefix(),
      role: 'PRIMARY',
      prefixRoleSlug: 'primary',
    });
  }

  beforeAll(async () => {
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    contextService = new ContextService(new DesignationOperatorPolicy());
    eventLog = new EventLogService(new EventLogRepository(prisma), logger as never, contextService);
    contextService.setSystemIntentFinalizer(new EventLogSystemFinalizer(eventLog, logger as never));

    const prefixService = new PrefixService(
      new PrefixRepository(prisma, contextService),
      contextService,
      {} as never,
      {} as never,
      dhcpPublisher as never,
      {} as never,
      {} as never,
      {} as never,
      logger as never,
    );
    hostPlugin = new HostPluginIpamProvisioning(
      contextService,
      prefixService,
      {} as never,
      {} as never,
      new IpamRoleRepository(prisma),
      eventLog,
    );

    const org = await prisma.organization.create({
      data: { name: `it-sysevent-${randomUUID()}`, tenantType: 'SupplyCustomer' },
    });
    organizationId = org.id;
    zoneId = (await prisma.zone.create({ data: { name: `z-${randomUUID().slice(0, 8)}`, organizationId } })).id;

    const existingRole = await prisma.ipamPrefixVlanRole.findFirst({ where: { slug: 'primary' } });
    createdPrefixRole = existingRole === null;
    prefixRoleId =
      existingRole?.id ??
      (await prisma.ipamPrefixVlanRole.create({ data: { name: 'Primary', slug: 'primary', weight: 1000 } })).id;
  }, 60_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.changelog.deleteMany({ where: { organizationId } });
    await prisma.prefix.deleteMany({ where: { organizationId } });
    await prisma.zone.deleteMany({ where: { id: zoneId } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    if (createdPrefixRole) {
      await prisma.ipamPrefixVlanRole.deleteMany({ where: { id: prefixRoleId } });
    }
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
  });

  it('records exactly one SYSTEM row for a plugin create-prefix, owned by the target organization', async () => {
    const created = await createPrefixThroughPlugin();

    const rows = await rowsForOrg();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      organizationId,
      actorType: 'SYSTEM',
      actorId: null,
      actorLabel: null,
      apiKeyId: null,
      actionKey: 'ipam.create',
      resource: 'ipam',
      action: 'create',
      outcome: 'SUCCEEDED',
      errorCode: null,
      tier: 'ACTIVITY',
      durability: 'BEST_EFFORT',
    });
    expect(await prisma.prefix.findUnique({ where: { id: created.id } })).not.toBeNull();
  });

  it('records exactly one SYSTEM row when the scope is entered synchronously', async () => {
    const returned = contextService.runAsSystem(organizationId, () => {
      contextService.requirePermission('ipam', 'create');
      return 'sync-result';
    });

    expect(returned).toBe('sync-result');

    await sleep(200);
    const rows = await rowsForOrg();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'SYSTEM', actorId: null, actionKey: 'ipam.create' });
  });

  it('records a FAILED SYSTEM row when the plugin write throws after the gate', async () => {
    await expect(createPrefixThroughPlugin({ zoneId: randomUUID() })).rejects.toThrow(NotFoundException);

    const rows = await rowsForOrg();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'SYSTEM',
      actorId: null,
      actionKey: 'ipam.create',
      outcome: 'FAILED',
      errorCode: '404:NotFoundException',
    });
  });

  it('writes one row per scope, never re-writing an earlier scope’s intents', async () => {
    await createPrefixThroughPlugin();
    await createPrefixThroughPlugin();

    const rows = await rowsForOrg();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.actorType === 'SYSTEM' && row.actionKey === 'ipam.create')).toBe(true);
  });

  it('writes one SYSTEM row and one UI row when nested inside a request, stealing neither', async () => {
    const requestId = `req-${randomUUID()}`;
    const interceptor = new EventLogInterceptor(contextService, eventLog, new Reflector(), logger as never);
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          path: '/api/v1/ipam/prefixes',
          params: {},
          ip: '203.0.113.9',
          headers: { 'user-agent': 'vitest' },
        }),
      }),
      getHandler: () => () => undefined,
    };

    await new Promise<void>((resolve, reject) => {
      contextService.run({ requestId, identity: identity(['ipam:create']) }, () => {
        const handler = async () => {
          contextService.requirePermission('ipam', 'create');
          return createPrefixThroughPlugin();
        };
        interceptor
          .intercept(executionContext as never, { handle: () => from(handler()) })
          .subscribe({ error: reject, complete: resolve });
      });
    });

    const rows = await settledRowsFor(requestId, 2);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.actorType === 'SYSTEM')).toHaveLength(1);
    expect(rows.filter((row) => row.actorType === 'UI')).toHaveLength(1);

    const systemRow = rows.find((row) => row.actorType === 'SYSTEM');
    expect(systemRow).toMatchObject({ actionKey: 'ipam.create', actorId: null, path: null, method: null });

    const uiRow = rows.find((row) => row.actorType === 'UI');
    expect(uiRow).toMatchObject({ actionKey: 'ipam.create', actorId: 'u-int-sys', path: '/api/v1/ipam/prefixes' });
  });

  it('hides the finalized SYSTEM rows from the default browse and reveals them on request', async () => {
    await createPrefixThroughPlugin();

    const query = (overrides: Partial<EventLogQuery> = {}): EventLogQuery => ({ page: 1, ...overrides });
    const hidden = await runInRequest(`req-${randomUUID()}`, ['event-log:access'], () => eventLog.list(query()));
    const shown = await runInRequest(`req-${randomUUID()}`, ['event-log:access'], () =>
      eventLog.list(query({ includeSystemActors: true })),
    );

    expect(hidden.data).toHaveLength(0);
    expect(shown.data).toHaveLength(1);
    expect(shown.data[0]).toMatchObject({ actorType: 'SYSTEM', actionKey: 'ipam.create', actorId: null });
  });
});
