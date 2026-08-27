import { Reflector } from '@nestjs/core';
import { MAIN_APP_PERMISSIONS, RbacService } from '@repo/auth/rbac';
import { createPrismaClientOptions, OrganizationMembershipRole } from '@repo/database';
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
import { OrganizationRolesService } from '../../organization-roles.service';
import { OrganizationMembershipsController } from '../organization-members.controller';
import { OrganizationMembershipsRepository } from '../organization-members.repository';
import { OrganizationMembershipsService } from '../organization-members.service';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('member event capture (integration, live DB)', () => {
  let prisma: PrismaClient;
  let rbacService: RbacService;
  let contextService: ContextService;
  let repository: OrganizationMembershipsRepository;
  let organizationId: string;
  let actorUserId: string;
  let devicePermissionId: string;
  let systemMemberRoleId: string;
  let actorPermissions: string[];
  const createdRoleIds: string[] = [];
  const createdUserIds: string[] = [];

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

  function identity(permissions: string[] = actorPermissions, userId: string = actorUserId): IdentityContext {
    return {
      authType: AuthType.Session,
      role: 'Admin',
      organizationId,
      organization: { id: organizationId },
      permissions: new Set(permissions),
      session: { user: { id: userId, email: 'actor@example.com' } },
    } as unknown as IdentityContext;
  }

  const realEventLog = () => new EventLogService(new EventLogRepository(prisma), logger as never, contextService);

  const throwingEventLog = () =>
    ({
      recordInTransaction: vi.fn().mockRejectedValue(new Error('event write failed')),
    }) as unknown as EventLogService;

  const eventBus = { emit: vi.fn() };

  function buildService(eventLog: EventLogService) {
    return new OrganizationMembershipsService(
      repository,
      contextService,
      rbacService,
      eventBus as never,
      eventLog,
      prisma,
      logger as never,
    );
  }

  const buildRolesService = (eventLog: EventLogService) =>
    new OrganizationRolesService(contextService, rbacService, eventLog, logger as never);

  async function makeMemberRole(): Promise<string> {
    const role = await prisma.organizationMemberRole.create({
      data: {
        name: `int-member-role-${randomUUID().slice(0, 8)}`,
        slug: `int-member-role-${randomUUID().slice(0, 8)}`,
        isSystem: false,
        organizationId,
        rolePermissions: { create: [{ permissionId: devicePermissionId }] },
      },
    });
    createdRoleIds.push(role.id);
    return role.id;
  }

  async function makeMembership(userId?: string): Promise<{ id: string; userId: string; email: string }> {
    const email = `int-member-${randomUUID().slice(0, 8)}@example.com`;
    let memberUserId = userId;
    if (!memberUserId) {
      const user = await prisma.user.create({ data: { email, name: 'Int Member' } });
      createdUserIds.push(user.id);
      memberUserId = user.id;
    }
    const member = await prisma.member.create({
      data: {
        organizationId,
        userId: memberUserId,
        role: OrganizationMembershipRole.Member,
        assignedRoleId: await makeMemberRole(),
      },
      include: { user: { select: { email: true } } },
    });
    return { id: member.id, userId: member.userId, email: member.user.email };
  }

  const runInContext = <T>(fn: () => Promise<T>, permissions?: string[], userId?: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run(
        {
          requestId: `req-${randomUUID()}`,
          identity: identity(permissions, userId),
          method: 'DELETE',
          path: '/api/v1/organizations/members',
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

  async function throughInterceptor(args: {
    handler: (...handlerArgs: never[]) => unknown;
    eventLog: EventLogService;
    invoke: (service: OrganizationMembershipsService) => Promise<unknown>;
    permissions?: string[];
    userId?: string;
  }): Promise<string> {
    const service = buildService(args.eventLog);
    const interceptor = new EventLogInterceptor(contextService, realEventLog(), new Reflector(), logger as never);
    const requestId = `req-${randomUUID()}`;
    const executionContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'DELETE',
          path: '/api/v1/organizations/members',
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
          identity: identity(args.permissions, args.userId),
          method: 'DELETE',
          path: '/api/v1/organizations/members',
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
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    rbacService = new RbacService(prisma, { permissions: MAIN_APP_PERMISSIONS, systemRoles: [] });
    contextService = new ContextService(new DesignationOperatorPolicy());
    repository = new OrganizationMembershipsRepository(prisma);

    const org = await prisma.organization.create({
      data: { name: `it-member-evlog-${randomUUID()}`, tenantType: 'SupplyCustomer' },
    });
    organizationId = org.id;

    const actor = await prisma.user.create({
      data: { email: `int-actor-${randomUUID().slice(0, 8)}@example.com`, name: 'Int Actor' },
    });
    createdUserIds.push(actor.id);
    actorUserId = actor.id;

    const permission = await prisma.permission.upsert({
      where: { resource_action: { resource: 'device', action: 'read' } },
      update: {},
      create: { resource: 'device', action: 'read', description: 'View devices' },
    });
    devicePermissionId = permission.id;

    systemMemberRoleId = await repository.requireSystemRoleId(OrganizationMembershipRole.Member);
    const systemRole = await prisma.organizationMemberRole.findUniqueOrThrow({
      where: { id: systemMemberRoleId },
      select: { rolePermissions: { select: { permission: { select: { resource: true, action: true } } } } },
    });
    actorPermissions = [
      'member:delete',
      'member:change-role',
      'device:read',
      ...systemRole.rolePermissions.map((rp) => `${rp.permission.resource}:${rp.permission.action}`),
    ];
  }, 60_000);

  afterAll(async () => {
    await prisma.eventLog.deleteMany({ where: { organizationId } });
    await prisma.member.deleteMany({ where: { organizationId } });
    await prisma.rolePermission.deleteMany({ where: { roleId: { in: createdRoleIds } } });
    await prisma.organizationMemberRole.deleteMany({ where: { id: { in: createdRoleIds } } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await prisma.$disconnect();
  });

  describe('removal', () => {
    it('persists one atomic evidence row alongside the soft delete', async () => {
      const membership = await makeMembership();
      const service = buildService(realEventLog());

      await runInContext(() => service.removeOrganizationMembership(membership.id));

      const rows = await eventsFor(membership.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'member.removed',
        resource: 'member',
        action: 'removed',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        targetId: membership.id,
        targetLabel: membership.email,
        actorId: actorUserId,
      });
      expect(rows[0].metadata).toEqual({ userId: membership.userId });

      const row = await prisma.member.findUniqueOrThrow({ where: { id: membership.id } });
      expect(row.deletedAt).not.toBeNull();
    });

    it('records a self-removal that never required the delete permission', async () => {
      const selfUser = await prisma.user.create({
        data: { email: `int-self-${randomUUID().slice(0, 8)}@example.com`, name: 'Int Self' },
      });
      createdUserIds.push(selfUser.id);
      const membership = await makeMembership(selfUser.id);
      const service = buildService(realEventLog());
      const requirePermission = vi.spyOn(contextService, 'requirePermission');

      await runInContext(() => service.removeOrganizationMembership(membership.id), ['device:read'], selfUser.id);
      requirePermission.mockRestore();

      const rows = await eventsFor(membership.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'member.removed', outcome: 'SUCCEEDED', tier: 'EVIDENCE' });
      expect(requirePermission).not.toHaveBeenCalled();
    });

    it('rolls the soft delete back when the event write fails', async () => {
      const membership = await makeMembership();
      const service = buildService(throwingEventLog());

      await expect(runInContext(() => service.removeOrganizationMembership(membership.id))).rejects.toThrow(
        'event write failed',
      );

      const row = await prisma.member.findUniqueOrThrow({ where: { id: membership.id } });
      expect(row.deletedAt).toBeNull();
      expect(await eventsFor(membership.id)).toEqual([]);
    });
  });

  describe('role change', () => {
    it('persists one atomic evidence row alongside the assignment', async () => {
      const membership = await makeMembership();
      const service = buildService(realEventLog());

      await runInContext(() =>
        service.updateOrganizationMembershipRole(membership.id, { role: OrganizationMembershipRole.Member }),
      );

      const rows = await eventsFor(membership.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'member.role-changed',
        resource: 'member',
        action: 'role-changed',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        targetId: membership.id,
        targetLabel: membership.email,
      });
      expect(rows[0].metadata).toEqual({ userId: membership.userId, assignedRoleId: systemMemberRoleId });

      const row = await prisma.member.findUniqueOrThrow({ where: { id: membership.id } });
      expect(row.assignedRoleId).toBe(systemMemberRoleId);
    });

    it('rolls the assignment back when the event write fails', async () => {
      const membership = await makeMembership();
      const before = await prisma.member.findUniqueOrThrow({ where: { id: membership.id } });
      const service = buildService(throwingEventLog());

      await expect(
        runInContext(() =>
          service.updateOrganizationMembershipRole(membership.id, { role: OrganizationMembershipRole.Member }),
        ),
      ).rejects.toThrow('event write failed');

      const after = await prisma.member.findUniqueOrThrow({ where: { id: membership.id } });
      expect(after.assignedRoleId).toBe(before.assignedRoleId);
      expect(await eventsFor(membership.id)).toEqual([]);
    });

    it('writes exactly one row per action from either of the two emitting sites', async () => {
      const eventLog = realEventLog();
      const viaMembers = await makeMembership();
      const viaRoles = await makeMembership();

      await runInContext(() =>
        buildService(eventLog).updateOrganizationMembershipRole(viaMembers.id, {
          role: OrganizationMembershipRole.Member,
        }),
      );
      await runInContext(() => buildRolesService(eventLog).assignToMember(viaRoles.id, systemMemberRoleId));

      const fromMembers = await eventsFor(viaMembers.id);
      const fromRoles = await eventsFor(viaRoles.id);
      expect(fromMembers).toHaveLength(1);
      expect(fromRoles).toHaveLength(1);
      expect([fromMembers[0].actionKey, fromRoles[0].actionKey]).toEqual([
        'member.role-changed',
        'member.role-changed',
      ]);
    });
  });

  describe('tier 2 fallback', () => {
    it('records a failed removal from the unfinalized intent', async () => {
      const membership = await makeMembership();
      const requestId = await throughInterceptor({
        handler: OrganizationMembershipsController.prototype.deleteOrganizationMembership,
        eventLog: throwingEventLog(),
        invoke: (service) => service.removeOrganizationMembership(membership.id),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'member.removed',
        resource: 'member',
        action: 'delete',
        outcome: 'FAILED',
        tier: 'ACTIVITY',
        durability: 'BEST_EFFORT',
      });
    });

    it('records a denied removal under the key its success emits', async () => {
      const membership = await makeMembership();
      const requestId = await throughInterceptor({
        handler: OrganizationMembershipsController.prototype.deleteOrganizationMembership,
        eventLog: realEventLog(),
        permissions: ['member:read'],
        invoke: (service) => service.removeOrganizationMembership(membership.id),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'member.removed',
        outcome: 'DENIED',
        tier: 'ACTIVITY',
        durability: 'BEST_EFFORT',
      });
      const row = await prisma.member.findUniqueOrThrow({ where: { id: membership.id } });
      expect(row.deletedAt).toBeNull();
    });

    it('records a denied role change under the key its success emits', async () => {
      const membership = await makeMembership();
      const requestId = await throughInterceptor({
        handler: OrganizationMembershipsController.prototype.updateOrganizationMemberRole,
        eventLog: realEventLog(),
        permissions: ['member:read'],
        invoke: (service) =>
          service.updateOrganizationMembershipRole(membership.id, { role: OrganizationMembershipRole.Member }),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'member.role-changed', outcome: 'DENIED', tier: 'ACTIVITY' });
    });

    it('writes one evidence row and no synthetic row for a successful self-removal', async () => {
      const selfUser = await prisma.user.create({
        data: { email: `int-self-int-${randomUUID().slice(0, 8)}@example.com`, name: 'Int Self' },
      });
      createdUserIds.push(selfUser.id);
      const membership = await makeMembership(selfUser.id);
      const requestId = await throughInterceptor({
        handler: OrganizationMembershipsController.prototype.deleteOrganizationMembership,
        eventLog: realEventLog(),
        permissions: ['device:read'],
        userId: selfUser.id,
        invoke: (service) => service.removeOrganizationMembership(membership.id),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'member.removed',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        targetId: membership.id,
      });
    });

    it('records a failed self-removal that no permission gate would have caught', async () => {
      const selfUser = await prisma.user.create({
        data: { email: `int-self-fail-${randomUUID().slice(0, 8)}@example.com`, name: 'Int Self' },
      });
      createdUserIds.push(selfUser.id);
      const membership = await makeMembership(selfUser.id);
      const requestId = await throughInterceptor({
        handler: OrganizationMembershipsController.prototype.deleteOrganizationMembership,
        eventLog: throwingEventLog(),
        permissions: ['device:read'],
        userId: selfUser.id,
        invoke: (service) => service.removeOrganizationMembership(membership.id),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'member.removed',
        resource: 'member',
        action: 'delete',
        outcome: 'FAILED',
        tier: 'ACTIVITY',
      });
      const row = await prisma.member.findUniqueOrThrow({ where: { id: membership.id } });
      expect(row.deletedAt).toBeNull();
    });

    it('leaves a successful removal with its evidence row alone', async () => {
      const membership = await makeMembership();
      const requestId = await throughInterceptor({
        handler: OrganizationMembershipsController.prototype.deleteOrganizationMembership,
        eventLog: realEventLog(),
        invoke: (service) => service.removeOrganizationMembership(membership.id),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'member.removed', tier: 'EVIDENCE', outcome: 'SUCCEEDED' });
    });

    it('leaves a successful role change with its evidence row alone', async () => {
      const membership = await makeMembership();
      const requestId = await throughInterceptor({
        handler: OrganizationMembershipsController.prototype.updateOrganizationMemberRole,
        eventLog: realEventLog(),
        invoke: (service) =>
          service.updateOrganizationMembershipRole(membership.id, { role: OrganizationMembershipRole.Member }),
      });

      const rows = await settledRowsFor(requestId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ actionKey: 'member.role-changed', tier: 'EVIDENCE', outcome: 'SUCCEEDED' });
    });
  });
});
