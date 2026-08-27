import { Reflector } from '@nestjs/core';
import { MAIN_APP_PERMISSIONS, RbacService } from '@repo/auth/rbac';
import { createPrismaClientOptions } from '@repo/database';
import { randomUUID } from 'crypto';
import { from } from 'rxjs';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { EventLogInterceptor } from 'src/event-log/event-log.interceptor';
import { EventLogRepository } from 'src/event-log/event-log.repository';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrganizationRolesController } from '../organization-roles.controller';
import { OrganizationRolesService } from '../organization-roles.service';

type OwnerHandler = 'grantOwnerAccess' | 'revokeOwnerAccess' | 'transferOwnership';

const connectionString = process.env.DATABASE_URL;
const ROLE_PERMS = ['device:read'];
// The gate needs member:change-role; assertPermissionsWithinActor needs the role's own keys.
const ACTOR_PERMS = ['member:change-role', ...ROLE_PERMS];

describe.skipIf(!connectionString)('role event capture (integration, live DB)', () => {
  let prisma: PrismaClient;
  let rbacService: RbacService;
  let contextService: ContextService;
  let organizationId: string;
  let devicePermissionId: string;
  const createdRoleIds: string[] = [];

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  function identity(permissions: string[] = ACTOR_PERMS): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Admin',
      organizationId,
      organization: { id: organizationId },
      permissions: new Set(permissions),
      session: { user: { id: 'u-int-1', email: 'int@example.com' } },
    } as unknown as IdentityContext;
  }

  function buildService(eventLog: EventLogService) {
    return new OrganizationRolesService(contextService, rbacService, eventLog, logger as never);
  }

  const realEventLog = () => new EventLogService(new EventLogRepository(prisma), logger as never, contextService);

  const throwingEventLog = () =>
    ({
      recordInTransaction: vi.fn().mockRejectedValue(new Error('event write failed')),
    }) as unknown as EventLogService;

  async function makeCustomRoleRow(): Promise<{ id: string; name: string }> {
    const role = await prisma.organizationMemberRole.create({
      data: {
        name: `int-role-${randomUUID().slice(0, 8)}`,
        slug: `int-role-${randomUUID().slice(0, 8)}`,
        isSystem: false,
        organizationId,
        rolePermissions: { create: [{ permissionId: devicePermissionId }] },
      },
    });
    createdRoleIds.push(role.id);
    return { id: role.id, name: role.name };
  }

  const makeCustomRole = async (): Promise<string> => (await makeCustomRoleRow()).id;

  const runInContext = <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run(
        {
          requestId: `req-${randomUUID()}`,
          identity: identity(),
          method: 'POST',
          path: '/api/v1/organizations/roles',
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

  function invokeOwnerOperation(service: OrganizationRolesService, handler: OwnerHandler): Promise<unknown> {
    switch (handler) {
      case 'grantOwnerAccess':
        return service.grantOwnerAccess('m-1', 'r-owner');
      case 'revokeOwnerAccess':
        return service.revokeOwnerAccess('m-1', 'r-plain');
      case 'transferOwnership':
        return service.transferOwnership({
          sourceMemberId: 'm-src',
          recipientMemberId: 'm-dst',
          ownerRoleId: 'r-owner',
          sourceReplacementRoleId: 'r-plain',
        });
    }
  }

  async function throughInterceptor(args: {
    handler: (...handlerArgs: never[]) => unknown;
    permissions: string[];
    invoke: (service: OrganizationRolesService) => Promise<unknown>;
  }): Promise<string> {
    const eventLog = realEventLog();
    const service = buildService(eventLog);
    const interceptor = new EventLogInterceptor(contextService, eventLog, new Reflector(), logger as never);
    const requestId = `req-${randomUUID()}`;
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'POST',
          path: '/api/v1/organizations/roles',
          params: {},
          ip: '203.0.113.9',
          headers: { 'user-agent': 'vitest' },
        }),
      }),
      getHandler: () => args.handler,
    };

    await new Promise<void>((resolve) => {
      contextService.run(
        {
          requestId,
          identity: identity(args.permissions),
          method: 'POST',
          path: '/api/v1/organizations/roles',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          interceptor
            .intercept(executionContext as never, { handle: () => from(args.invoke(service)) })
            .subscribe({ error: () => resolve(), complete: () => resolve() });
        },
      );
    });

    return requestId;
  }

  beforeAll(async () => {
    // The app's subclass, not createPrismaClient's, so EventLogRepository takes it without a cast.
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    rbacService = new RbacService(prisma, { permissions: MAIN_APP_PERMISSIONS, systemRoles: [] });
    contextService = new ContextService(new DesignationOperatorPolicy());

    const org = await prisma.organization.create({
      data: { name: `it-evlog-${randomUUID()}`, tenantType: 'SupplyCustomer' },
    });
    organizationId = org.id;

    const permission = await prisma.permission.upsert({
      where: { resource_action: { resource: 'device', action: 'read' } },
      update: {},
      create: { resource: 'device', action: 'read', description: 'View devices' },
    });
    devicePermissionId = permission.id;
  }, 60_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
    await prisma.organizationMemberRole.deleteMany({ where: { id: { in: createdRoleIds } } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  describe('withOwnerLock path — archiveCustom', () => {
    it('persists an atomic evidence row alongside the archival', async () => {
      const roleId = await makeCustomRole();
      const service = buildService(realEventLog());

      await runInContext(() => service.archiveCustom(roleId));

      const rows = await eventsFor(roleId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'role.archived',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        actorId: 'u-int-1',
        actorLabel: 'int@example.com',
      });

      const role = await prisma.organizationMemberRole.findUniqueOrThrow({ where: { id: roleId } });
      expect(role.archivedAt).not.toBeNull();
    });

    it('rolls the archival back when the event write fails', async () => {
      const roleId = await makeCustomRole();
      const service = buildService(throwingEventLog());

      await expect(runInContext(() => service.archiveCustom(roleId))).rejects.toThrow('event write failed');

      const role = await prisma.organizationMemberRole.findUniqueOrThrow({ where: { id: roleId } });
      expect(role.archivedAt).toBeNull();
      expect(await eventsFor(roleId)).toEqual([]);
    });
  });

  describe('bare-transaction path — updatePermissions', () => {
    it('persists an atomic evidence row alongside the permission replacement', async () => {
      const roleId = await makeCustomRole();
      const service = buildService(realEventLog());

      await runInContext(() => service.updatePermissions(roleId, ROLE_PERMS));

      const rows = await eventsFor(roleId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'role.permissions-changed',
        resource: 'role',
        durability: 'ATOMIC',
      });
      expect(rows[0].metadata).toEqual({ grantedKeys: ROLE_PERMS });
    });

    it('rolls the permission replacement back when the event write fails', async () => {
      const roleId = await makeCustomRole();
      const service = buildService(throwingEventLog());
      const before = await prisma.rolePermission.findMany({ where: { roleId }, select: { permissionId: true } });

      await expect(runInContext(() => service.updatePermissions(roleId, []))).rejects.toThrow('event write failed');

      const after = await prisma.rolePermission.findMany({ where: { roleId }, select: { permissionId: true } });
      expect(after).toEqual(before);
      expect(await eventsFor(roleId)).toEqual([]);
    });
  });

  describe('created roles', () => {
    it('targets the DB-assigned uuid, not the slug', async () => {
      const slug = `int-new-${randomUUID().slice(0, 8)}`;
      const service = buildService(realEventLog());

      const created = await runInContext(() =>
        service.createCustom({ name: 'Created', slug, permissions: ROLE_PERMS }),
      );
      const roleId = (created as { id: string }).id;
      createdRoleIds.push(roleId);

      const rows = await eventsFor(roleId);
      expect(rows).toHaveLength(1);
      expect(rows[0].actionKey).toBe('role.created');
      expect(rows[0].targetId).toBe(roleId);
      expect(rows[0].targetId).not.toBe(slug);
    });
  });

  describe('provenance', () => {
    it('records the request id so rows from one request correlate', async () => {
      const roleId = await makeCustomRole();
      const service = buildService(realEventLog());

      await runInContext(() => service.archiveCustom(roleId));

      const [row] = await eventsFor(roleId);
      expect(row.requestId).toMatch(/^req-/);
    });

    it('records the request method and path on a created role', async () => {
      const slug = `int-prov-${randomUUID().slice(0, 8)}`;
      const service = buildService(realEventLog());

      await runInContext(() => service.createCustom({ name: 'Provenanced', slug, permissions: ROLE_PERMS }));
      const created = await prisma.organizationMemberRole.findUniqueOrThrow({
        where: { slug_organizationId: { slug, organizationId } },
      });
      createdRoleIds.push(created.id);

      const [row] = await eventsFor(created.id);
      expect(row.method).toBe('POST');
      expect(row.path).toBe('/api/v1/organizations/roles');
      expect(row.ipAddress).toBe('203.0.113.9');
      expect(row.userAgent).toBe('vitest');
    });
  });

  describe('target labels', () => {
    it('names the role on a permission change', async () => {
      const role = await makeCustomRoleRow();
      const service = buildService(realEventLog());

      await runInContext(() => service.updatePermissions(role.id, ROLE_PERMS));

      const [row] = await eventsFor(role.id);
      expect(row.targetLabel).toBe(role.name);
    });

    it('names the role on an archival', async () => {
      const role = await makeCustomRoleRow();
      const service = buildService(realEventLog());

      await runInContext(() => service.archiveCustom(role.id));

      const [row] = await eventsFor(role.id);
      expect(row.targetLabel).toBe(role.name);
    });
  });

  describe('denied and failed attempts (tier 2 fallback)', () => {
    it('records a denied creation as the role operation, not the permission that gated it', async () => {
      const requestId = await throughInterceptor({
        handler: OrganizationRolesController.prototype.createCustomRole,
        permissions: [],
        invoke: (service) =>
          service.createCustom({
            name: 'Denied',
            slug: `int-denied-${randomUUID().slice(0, 8)}`,
            permissions: ROLE_PERMS,
          }),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'role.created', outcome: 'DENIED', tier: 'ACTIVITY' });
    });

    it('records a denied member assignment under the same key its success emits', async () => {
      const requestId = await throughInterceptor({
        handler: OrganizationRolesController.prototype.assignRoleToMember,
        permissions: [],
        invoke: (service) => service.assignToMember('m-1', 'r-1'),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'member.role-changed', outcome: 'DENIED' });
    });

    it.each([
      ['grantOwnerAccess', 'organization.owner-granted'],
      ['revokeOwnerAccess', 'organization.owner-revoked'],
      ['transferOwnership', 'organization.ownership-transferred'],
    ] as const)('records a denied %s attempt', async (handler, actionKey) => {
      const requestId = await throughInterceptor({
        handler: OrganizationRolesController.prototype[handler],
        permissions: [],
        invoke: (service) => invokeOwnerOperation(service, handler),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey, outcome: 'DENIED', tier: 'ACTIVITY' });
    });

    it('leaves a successful creation with its evidence row alone', async () => {
      const slug = `int-once-${randomUUID().slice(0, 8)}`;
      const requestId = await throughInterceptor({
        handler: OrganizationRolesController.prototype.createCustomRole,
        permissions: ACTOR_PERMS,
        invoke: (service) => service.createCustom({ name: 'Once', slug, permissions: ROLE_PERMS }),
      });
      const created = await prisma.organizationMemberRole.findUniqueOrThrow({
        where: { slug_organizationId: { slug, organizationId } },
      });
      createdRoleIds.push(created.id);

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'role.created', tier: 'EVIDENCE' });
    });
  });
});
