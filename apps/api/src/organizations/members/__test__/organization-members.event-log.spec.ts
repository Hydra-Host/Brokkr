import { Reflector } from '@nestjs/core';
import { isMutatingPermission, MAIN_APP_PERMISSIONS, permissionKey } from '@repo/auth/rbac';
import { OrganizationMembershipRole, type Prisma } from '@repo/database';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService } from 'src/common/context/context.service';
import type { EventLogWrite } from 'src/event-log/event-log.types';
import { describe, expect, it, vi } from 'vitest';
import { AUDIT_ACTION_KEY, type AuditActionOptions } from 'src/event-log/audit-action.decorator';
import { OrganizationMembershipsController } from '../organization-members.controller';
import { OrganizationMembershipsService } from '../organization-members.service';

const ORG = 'org-1';
const ACTOR_USER = 'u-actor';
const TARGET_USER = 'u-target';
const MEMBERSHIP = 'membership-1';
const TARGET_EMAIL = 'target@example.com';

const assignedRole = {
  id: 'role-reader',
  name: 'Reader',
  slug: 'reader',
  isSystem: false,
  rolePermissions: [{ permission: { resource: 'member', action: 'read' } }],
};

const TX = {
  member: {
    findUniqueOrThrow: async () => ({ userId: TARGET_USER, user: { email: TARGET_EMAIL } }),
  },
} as unknown as Prisma.TransactionClient;

type Emit = (tx: Prisma.TransactionClient) => Promise<void>;

function identity(): IdentityContext {
  return {
    authType: AuthType.Session,
    role: 'Admin',
    organizationId: ORG,
    organization: { id: ORG },
    permissions: new Set(['member:delete', 'member:change-role']),
    session: { user: { id: ACTOR_USER, email: 'actor@example.com' } },
  } as unknown as IdentityContext;
}

function build(targetUserId: string = TARGET_USER) {
  const membership = {
    id: MEMBERSHIP,
    userId: targetUserId,
    organizationId: ORG,
    role: OrganizationMembershipRole.Member,
    assignedRoleId: assignedRole.id,
    assignedRole,
    user: { email: TARGET_EMAIL },
  };

  const repo = {
    findByIdAndOrganizationId: vi.fn().mockResolvedValue(membership),
    requireSystemRoleId: vi.fn().mockResolvedValue('role-admin'),
    delete: vi.fn().mockResolvedValue(membership),
  };

  const writes: EventLogWrite[] = [];
  const txSeen: Prisma.TransactionClient[] = [];
  const eventLog = {
    recordInTransaction: vi.fn(async (tx: Prisma.TransactionClient, write: EventLogWrite) => {
      txSeen.push(tx);
      writes.push(write);
    }),
  };

  const emits: Emit[] = [];
  const rbacService = {
    assertOrdinaryMemberActionAllowed: vi.fn(),
    assignRoleToMember: vi.fn(async (_o, _m, _r, _a, emit?: Emit) => {
      if (emit) emits.push(emit);
      await emit?.(TX);
      return { id: MEMBERSHIP };
    }),
  };

  const prisma = {
    $transaction: vi.fn((fn: (tx: Prisma.TransactionClient) => Promise<unknown>) => fn(TX)),
  };

  const contextService = new ContextService(new DesignationOperatorPolicy());
  const eventBus = { emit: vi.fn() };
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const service = new OrganizationMembershipsService(
    repo as never,
    contextService,
    rbacService as never,
    eventBus as never,
    eventLog as never,
    prisma as never,
    logger as never,
  );

  const run = async (fn: () => Promise<unknown>) => {
    let result: unknown;
    await new Promise<void>((resolve) => {
      contextService.run(
        {
          requestId: 'req-1',
          identity: identity(),
          method: 'DELETE',
          path: '/api/v1/organizations/members/membership-1',
          ipAddress: '203.0.113.9',
          userAgent: 'vitest',
        },
        () => {
          void fn()
            .then((value) => {
              result = value;
            })
            .finally(resolve);
        },
      );
    });
    return result;
  };

  return {
    service,
    contextService,
    repo,
    rbacService,
    eventLog,
    eventBus,
    prisma,
    logger,
    writes,
    txSeen,
    emits,
    run,
  };
}

describe('OrganizationMembershipsService event capture', () => {
  it('records a removal as one member.removed row targeting the membership', async () => {
    const { service, writes, run } = build();

    await run(() => service.removeOrganizationMembership(MEMBERSHIP));

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'member',
      action: 'removed',
      actionKey: 'member.removed',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      outcome: 'SUCCEEDED',
      organizationId: ORG,
      targetId: MEMBERSHIP,
      targetLabel: TARGET_EMAIL,
    });
    expect(writes[0].metadata).toMatchObject({ userId: TARGET_USER });
  });

  it('records a role change as one member.role-changed row targeting the membership', async () => {
    const { service, writes, run } = build();

    await run(() =>
      service.updateOrganizationMembershipRole(MEMBERSHIP, { role: OrganizationMembershipRole.Admin }),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      resource: 'member',
      action: 'role-changed',
      actionKey: 'member.role-changed',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      outcome: 'SUCCEEDED',
      targetId: MEMBERSHIP,
      targetLabel: TARGET_EMAIL,
    });
    expect(writes[0].metadata).toMatchObject({ userId: TARGET_USER, assignedRoleId: 'role-admin' });
  });

  it('hands RbacService a single emit callback so the shipped roles path cannot double it', async () => {
    const { service, rbacService, emits, writes, run } = build();

    await run(() =>
      service.updateOrganizationMembershipRole(MEMBERSHIP, { role: OrganizationMembershipRole.Admin }),
    );

    expect(rbacService.assignRoleToMember).toHaveBeenCalledOnce();
    expect(emits).toHaveLength(1);
    expect(writes.filter((write) => write.actionKey === 'member.role-changed')).toHaveLength(1);
  });

  it('records a self-removal even though the delete permission is never required', async () => {
    const { service, contextService, writes, run } = build(ACTOR_USER);
    const requirePermission = vi.spyOn(contextService, 'requirePermission');

    await run(() => service.removeOrganizationMembership(MEMBERSHIP));

    expect(requirePermission).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0].actionKey).toBe('member.removed');
  });

  it('records and supersedes an intent for a self-removal so no synthetic row is minted', async () => {
    const { service, contextService, run } = build(ACTOR_USER);
    let gated = false;
    let pending: unknown[] = [];

    await run(async () => {
      await service.removeOrganizationMembership(MEMBERSHIP);
      gated = contextService.hasRecordedIntents;
      pending = contextService.drainIntents();
      return undefined;
    });

    expect(gated).toBe(true);
    expect(pending).toEqual([]);
  });

  it('leaves the self-removal intent unfinalized when the removal rolls back', async () => {
    const { service, contextService, prisma, run } = build(ACTOR_USER);
    prisma.$transaction.mockRejectedValueOnce(new Error('event write failed'));
    let pending: unknown[] = [];

    await run(async () => {
      await service.removeOrganizationMembership(MEMBERSHIP).catch(() => undefined);
      pending = contextService.drainIntents();
      return undefined;
    });

    expect(pending).toEqual([
      expect.objectContaining({ resource: 'member', action: 'delete', denied: false, finalized: false }),
    ]);
  });

  it('shares the removal transaction between the soft delete and the event insert', async () => {
    const { service, repo, txSeen, run } = build();

    await run(() => service.removeOrganizationMembership(MEMBERSHIP));

    expect(repo.delete).toHaveBeenCalledWith(MEMBERSHIP, TX);
    expect(txSeen).toEqual([TX]);
  });

  it('shares the role-change transaction between the assignment and the event insert', async () => {
    const { service, txSeen, run } = build();

    await run(() =>
      service.updateOrganizationMembershipRole(MEMBERSHIP, { role: OrganizationMembershipRole.Admin }),
    );

    expect(txSeen).toEqual([TX]);
  });

  it('attributes both events to the acting session user with request provenance', async () => {
    const { service, writes, run } = build();

    await run(() => service.removeOrganizationMembership(MEMBERSHIP));
    await run(() =>
      service.updateOrganizationMembershipRole(MEMBERSHIP, { role: OrganizationMembershipRole.Admin }),
    );

    for (const write of writes) {
      expect(write).toMatchObject({
        actorType: 'UI',
        actorId: ACTOR_USER,
        actorLabel: 'actor@example.com',
        requestId: 'req-1',
        method: 'DELETE',
        path: '/api/v1/organizations/members/membership-1',
        ipAddress: '203.0.113.9',
        userAgent: 'vitest',
      });
    }
  });

  it('keeps the plugin bus emit and the audit log line alongside the event row', async () => {
    const { service, eventBus, logger, writes, run } = build();

    const result = await run(() => service.removeOrganizationMembership(MEMBERSHIP));

    expect(result).toMatchObject({ role: 'Reader' });
    expect(eventBus.emit).toHaveBeenCalledWith('member.removed', {
      organizationId: ORG,
      userId: TARGET_USER,
      email: TARGET_EMAIL,
    });
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining(MEMBERSHIP));
    expect(writes).toHaveLength(1);
  });

  it('supersedes the delete intent only after the removal commits', async () => {
    const { service, contextService, run } = build();
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await run(() => service.removeOrganizationMembership(MEMBERSHIP));

    expect(finalize).toHaveBeenCalledOnce();
  });

  it('leaves the delete intent unfinalized when the removal rolls back', async () => {
    const { service, contextService, prisma, run } = build();
    prisma.$transaction.mockRejectedValueOnce(new Error('event write failed'));
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await run(() => service.removeOrganizationMembership(MEMBERSHIP).catch(() => undefined));

    expect(finalize).not.toHaveBeenCalled();
  });

  it('leaves the change-role intent unfinalized when the assignment rolls back', async () => {
    const { service, contextService, rbacService, run } = build();
    rbacService.assignRoleToMember.mockRejectedValueOnce(new Error('event write failed'));
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await run(() =>
      service
        .updateOrganizationMembershipRole(MEMBERSHIP, { role: OrganizationMembershipRole.Admin })
        .catch(() => undefined),
    );

    expect(finalize).not.toHaveBeenCalled();
  });
});

describe('OrganizationMembershipsController audit metadata', () => {
  const auditActionFor = (handler: (...args: never[]) => unknown) =>
    new Reflector().get<AuditActionOptions | undefined>(AUDIT_ACTION_KEY, handler);

  it.each([
    ['deleteOrganizationMembership', 'member.removed', 'delete'],
    ['updateOrganizationMemberRole', 'member.role-changed', 'change-role'],
  ] as const)('gates %s on a mutating catalog permission', (handler, actionKey, action) => {
    const options = auditActionFor(OrganizationMembershipsController.prototype[handler]);

    expect(options).toMatchObject({ actionKey, resource: 'member', action });
    expect(isMutatingPermission(MAIN_APP_PERMISSIONS, permissionKey('member', action))).toBe(true);
  });

  it('keys both handlers on the action the tier 1 emitters write', () => {
    const remove = auditActionFor(OrganizationMembershipsController.prototype.deleteOrganizationMembership);
    const change = auditActionFor(OrganizationMembershipsController.prototype.updateOrganizationMemberRole);

    expect([remove?.actionKey, change?.actionKey]).toEqual(['member.removed', 'member.role-changed']);
  });
});
