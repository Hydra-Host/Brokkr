import { MAIN_APP_PERMISSIONS, RbacService } from '@repo/auth/rbac';
import { createPrismaClientOptions } from '@repo/database';
import { randomUUID } from 'crypto';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import { EventLogRepository } from 'src/event-log/event-log.repository';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { OrganizationMembershipsRepository } from '../../members/organization-members.repository';
import { OrganizationInvitationsRepository } from '../organization-invitations.repository';
import { OrganizationInvitationsService } from '../organization-invitations.service';

const connectionString = process.env.DATABASE_URL;
const INVITER_PERMS = ['invitation:create', 'invitation:delete'];

describe.skipIf(!connectionString)('invitation event capture (integration, live DB)', () => {
  let prisma: PrismaClient;
  let rbacService: RbacService;
  let contextService: ContextService;
  let inviteOrganizationId: string;
  let actorOrganizationId: string;
  let roleId: string;
  let inviterUserId: string;
  let inviteeUserId: string;
  let inviteeEmail: string;

  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const eventBus = { emit: vi.fn() };
  const emailService = { send: { organizationInvite: vi.fn().mockResolvedValue(undefined) } };

  const realEventLog = () => new EventLogService(new EventLogRepository(prisma), logger as never, contextService);

  const throwingEventLog = () =>
    ({
      recordInTransaction: vi.fn().mockRejectedValue(new Error('event write failed')),
      record: vi.fn().mockRejectedValue(new Error('event write failed')),
    }) as unknown as EventLogService;

  function buildService(eventLog: EventLogService) {
    return new OrganizationInvitationsService(
      contextService,
      rbacService,
      emailService as never,
      eventBus as never,
      new OrganizationInvitationsRepository(prisma),
      new OrganizationMembershipsRepository(prisma),
      eventLog,
      logger as never,
    );
  }

  function identity(args: { organizationId: string; userId: string; email: string; permissions: string[] }) {
    return {
      authType: AuthType.Session,
      role: 'Admin',
      organizationId: args.organizationId,
      organization: { id: args.organizationId },
      permissions: new Set(args.permissions),
      session: { user: { id: args.userId, email: args.email, firstName: 'Int', lastName: 'Tester' } },
    } as unknown as IdentityContext;
  }

  const inviterIdentity = () =>
    identity({
      organizationId: inviteOrganizationId,
      userId: inviterUserId,
      email: 'int-inviter@example.com',
      permissions: INVITER_PERMS,
    });

  const inviteeIdentity = () =>
    identity({ organizationId: actorOrganizationId, userId: inviteeUserId, email: inviteeEmail, permissions: [] });

  const runInContext = <T>(actor: IdentityContext, fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      contextService.run(
        {
          requestId: `req-${randomUUID()}`,
          identity: actor,
          method: 'POST',
          path: '/api/v1/organizations/invitations',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          fn().then(resolve, reject);
        },
      );
    });

  const eventsFor = (targetId: string) =>
    prisma.eventLog.findMany({ where: { targetId }, orderBy: { createdAt: 'asc' } });

  async function makeInvitation(status = 'pending'): Promise<string> {
    const invitation = await prisma.invitation.create({
      data: {
        email: inviteeEmail,
        organizationId: inviteOrganizationId,
        assignedRoleId: roleId,
        inviterId: inviterUserId,
        status,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    return invitation.id;
  }

  beforeAll(async () => {
    prisma = new PrismaClient(createPrismaClientOptions({ connectionString: connectionString! }));
    rbacService = new RbacService(prisma, { permissions: MAIN_APP_PERMISSIONS, systemRoles: [] });
    contextService = new ContextService(new DesignationOperatorPolicy());

    const [inviteOrg, actorOrg] = await Promise.all([
      prisma.organization.create({ data: { name: `it-inv-evlog-${randomUUID()}`, tenantType: 'SupplyCustomer' } }),
      prisma.organization.create({ data: { name: `it-inv-actor-${randomUUID()}`, tenantType: 'SupplyCustomer' } }),
    ]);
    inviteOrganizationId = inviteOrg.id;
    actorOrganizationId = actorOrg.id;

    const role = await prisma.organizationMemberRole.create({
      data: {
        name: `int-inv-role-${randomUUID().slice(0, 8)}`,
        slug: `int-inv-role-${randomUUID().slice(0, 8)}`,
        isSystem: false,
        organizationId: inviteOrganizationId,
      },
    });
    roleId = role.id;

    inviteeEmail = `int-invitee-${randomUUID().slice(0, 8)}@example.com`;
    const [inviter, invitee] = await Promise.all([
      prisma.user.create({ data: { email: `int-inviter-${randomUUID().slice(0, 8)}@example.com` } }),
      prisma.user.create({ data: { email: inviteeEmail } }),
    ]);
    inviterUserId = inviter.id;
    inviteeUserId = invitee.id;
  }, 60_000);

  afterEach(async () => {
    await prisma.member.deleteMany({ where: { organizationId: { in: [inviteOrganizationId, actorOrganizationId] } } });
    await prisma.invitation.deleteMany({ where: { organizationId: inviteOrganizationId } });
    await prisma.eventLog.deleteMany({
      where: { organizationId: { in: [inviteOrganizationId, actorOrganizationId] } },
    });
  });

  afterAll(async () => {
    await prisma.organizationMemberRole.deleteMany({ where: { id: roleId } });
    await prisma.user.deleteMany({ where: { id: { in: [inviterUserId, inviteeUserId] } } });
    await prisma.organization.deleteMany({ where: { id: { in: [inviteOrganizationId, actorOrganizationId] } } });
    await prisma.$disconnect();
  });

  describe('createInvitation', () => {
    it('persists an atomic evidence row alongside the invitation', async () => {
      const service = buildService(realEventLog());

      const created = await runInContext(inviterIdentity(), () =>
        service.createInvitation({ email: ` ${inviteeEmail.toUpperCase()} `, roleId }),
      );

      const rows = await eventsFor(created.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'member.invited',
        resource: 'member',
        action: 'invited',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        organizationId: inviteOrganizationId,
        targetLabel: inviteeEmail,
        actorId: inviterUserId,
      });
    });

    it('rolls the invitation back when the event write fails', async () => {
      const service = buildService(throwingEventLog());

      await expect(
        runInContext(inviterIdentity(), () => service.createInvitation({ email: inviteeEmail, roleId })),
      ).rejects.toThrow('event write failed');

      expect(await prisma.invitation.findMany({ where: { organizationId: inviteOrganizationId } })).toEqual([]);
    });
  });

  describe('acceptInvitation', () => {
    it('attributes the row to the inviting organization, not the accepting actor', async () => {
      const invitationId = await makeInvitation();
      const service = buildService(realEventLog());

      await runInContext(inviteeIdentity(), () => service.acceptInvitation(invitationId));

      const rows = await eventsFor(invitationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'member.joined',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        organizationId: inviteOrganizationId,
        targetLabel: inviteeEmail,
      });
      expect(await prisma.eventLog.findMany({ where: { organizationId: actorOrganizationId } })).toEqual([]);
    });

    it('rolls the membership and the claim back when the event write fails', async () => {
      const invitationId = await makeInvitation();
      const service = buildService(throwingEventLog());

      await expect(runInContext(inviteeIdentity(), () => service.acceptInvitation(invitationId))).rejects.toThrow(
        'event write failed',
      );

      const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
      expect(invitation.status).toBe('pending');
      expect(
        await prisma.member.findMany({ where: { userId: inviteeUserId, organizationId: inviteOrganizationId } }),
      ).toEqual([]);
      expect(await eventsFor(invitationId)).toEqual([]);
    });

    it('persists a post-commit failed row when the invitation is no longer pending', async () => {
      const invitationId = await makeInvitation('rejected');
      const service = buildService(realEventLog());

      await expect(runInContext(inviteeIdentity(), () => service.acceptInvitation(invitationId))).rejects.toThrow(
        "Cannot accept invitation with status 'rejected'",
      );

      const rows = await eventsFor(invitationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'member.joined',
        tier: 'EVIDENCE',
        durability: 'POST_COMMIT',
        outcome: 'FAILED',
        errorCode: '400:HttpException',
        organizationId: inviteOrganizationId,
        targetLabel: inviteeEmail,
      });
      expect(await prisma.eventLog.findMany({ where: { organizationId: actorOrganizationId } })).toEqual([]);
    });

    it('persists no row when the invitation does not exist', async () => {
      const service = buildService(realEventLog());
      const missingId = randomUUID();

      await expect(runInContext(inviteeIdentity(), () => service.acceptInvitation(missingId))).rejects.toThrow(
        'Invitation not found',
      );

      expect(await eventsFor(missingId)).toEqual([]);
      expect(await prisma.eventLog.findMany({ where: { organizationId: actorOrganizationId } })).toEqual([]);
    });
  });

  describe('rejectInvitation', () => {
    it('attributes the row to the inviting organization, not the rejecting actor', async () => {
      const invitationId = await makeInvitation();
      const service = buildService(realEventLog());

      await runInContext(inviteeIdentity(), () => service.rejectInvitation(invitationId));

      const rows = await eventsFor(invitationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'invitation.rejected',
        resource: 'invitation',
        action: 'rejected',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        organizationId: inviteOrganizationId,
      });
      expect(await prisma.eventLog.findMany({ where: { organizationId: actorOrganizationId } })).toEqual([]);
    });

    it('rolls the rejection back when the event write fails', async () => {
      const invitationId = await makeInvitation();
      const service = buildService(throwingEventLog());

      await expect(runInContext(inviteeIdentity(), () => service.rejectInvitation(invitationId))).rejects.toThrow(
        'event write failed',
      );

      const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
      expect(invitation.status).toBe('pending');
    });

    it('persists a post-commit failed row when the invitation is no longer pending', async () => {
      const invitationId = await makeInvitation('accepted');
      const service = buildService(realEventLog());

      await expect(runInContext(inviteeIdentity(), () => service.rejectInvitation(invitationId))).rejects.toThrow(
        "Cannot reject invitation with status 'accepted'",
      );

      const rows = await eventsFor(invitationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'invitation.rejected',
        tier: 'EVIDENCE',
        durability: 'POST_COMMIT',
        outcome: 'FAILED',
        errorCode: '400:HttpException',
        organizationId: inviteOrganizationId,
      });
      expect(await prisma.eventLog.findMany({ where: { organizationId: actorOrganizationId } })).toEqual([]);
    });
  });

  describe('cancelInvitation', () => {
    it('persists an atomic evidence row alongside the cancellation', async () => {
      const invitationId = await makeInvitation();
      const service = buildService(realEventLog());

      await runInContext(inviterIdentity(), () => service.cancelInvitation(invitationId));

      const rows = await eventsFor(invitationId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actionKey: 'invitation.cancelled',
        resource: 'invitation',
        action: 'cancelled',
        tier: 'EVIDENCE',
        durability: 'ATOMIC',
        outcome: 'SUCCEEDED',
        organizationId: inviteOrganizationId,
      });

      const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
      expect(invitation.status).toBe('canceled');
    });

    it('rolls the cancellation back when the event write fails', async () => {
      const invitationId = await makeInvitation();
      const service = buildService(throwingEventLog());

      await expect(runInContext(inviterIdentity(), () => service.cancelInvitation(invitationId))).rejects.toThrow(
        'event write failed',
      );

      const invitation = await prisma.invitation.findUniqueOrThrow({ where: { id: invitationId } });
      expect(invitation.status).toBe('pending');
    });
  });
});
