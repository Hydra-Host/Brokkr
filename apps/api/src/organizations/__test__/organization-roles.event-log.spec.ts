import { ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@repo/database';
import { AuthType, type IdentityContext } from 'src/auth/identity-context';
import { DesignationOperatorPolicy } from 'src/common/authz/operator-policy';
import { ContextService, type PermissionIntent } from 'src/common/context/context.service';
import type { EventLogWrite } from 'src/event-log/event-log.types';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationRolesService } from '../organization-roles.service';

const ORG = 'org-1';
const CREATED_ROLE_ID = '3f0f1d6e-0000-4000-8000-00000000r0le'.replace('r0le', '0001');
const TX = {
  organizationMemberRole: {
    findUniqueOrThrow: async () => ({ id: CREATED_ROLE_ID }),
    findUnique: async () => ({ name: 'Existing Role' }),
  },
} as unknown as Prisma.TransactionClient;

type Emit = (tx: Prisma.TransactionClient) => Promise<void>;

function ownerIdentity(): IdentityContext {
  return {
    authType: AuthType.Session,
    role: 'Owner',
    organizationId: ORG,
    organization: { id: ORG },
    permissions: new Set(['member:change-role']),
    session: { user: { id: 'u-1', email: 'owner@example.com' } },
  } as unknown as IdentityContext;
}

function build() {
  const writes: EventLogWrite[] = [];
  const eventLog = {
    recordInTransaction: vi.fn(async (tx: Prisma.TransactionClient, write: EventLogWrite) => {
      expect(tx).toBe(TX);
      writes.push(write);
    }),
  };

  // Every mocked mutation invokes the emit callback it was handed, exactly as the real
  // service does inside its transaction.
  const runEmit = async (emit?: Emit) => {
    await emit?.(TX);
    return { id: 'result' };
  };

  const rbacService = {
    isOwnerCapable: vi.fn().mockReturnValue(true),
    createCustomRole: vi.fn((_o, _d, _p, emit?: Emit) => runEmit(emit)),
    cloneSystemRole: vi.fn((_o, _s, _n, _sl, _p, emit?: Emit) => runEmit(emit)),
    updateRolePermissions: vi.fn((_r, _p, _o, _ap, emit?: Emit) => runEmit(emit)),
    archiveCustomRole: vi.fn((_r, _o, _p, emit?: Emit) => runEmit(emit)),
    assignRoleToMember: vi.fn((_o, _m, _r, _a, emit?: Emit) => runEmit(emit)),
    grantOwnerAccess: vi.fn((_o, _m, _r, _p, emit?: Emit) => runEmit(emit)),
    revokeOwnerAccess: vi.fn((_o, _m, _r, _p, emit?: Emit) => runEmit(emit)),
    transferOwnership: vi.fn((_o, _s, _r, _or, _sr, _p, emit?: Emit) => runEmit(emit)),
  };

  const contextService = new ContextService(new DesignationOperatorPolicy());
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const service = new OrganizationRolesService(
    contextService,
    rbacService as never,
    eventLog as never,
    logger as never,
  );

  const run = async (fn: () => Promise<unknown>) => {
    let result: unknown;
    await new Promise<void>((resolve) => {
      contextService.run(
        {
          requestId: 'req-1',
          identity: ownerIdentity(),
          method: 'POST',
          path: '/api/v1/organization/roles',
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

  return { service, contextService, rbacService, eventLog, writes, run };
}

describe('OrganizationRolesService event capture', () => {
  it('labels a role permission change as role.permissions-changed, not member.role-changed', async () => {
    const { service, writes, run } = build();

    await run(() => service.updatePermissions('r-1', ['device:read']));

    expect(writes).toHaveLength(1);
    expect(writes[0].actionKey).toBe('role.permissions-changed');
    expect(writes[0].resource).toBe('role');
  });

  it('labels a member role assignment as member.role-changed', async () => {
    const { service, writes, run } = build();

    await run(() => service.assignToMember('m-1', 'r-1'));

    expect(writes[0].actionKey).toBe('member.role-changed');
    expect(writes[0].resource).toBe('member');
  });

  it('labels role creation and cloning as role.created', async () => {
    const { service, writes, run } = build();

    await run(() => service.createCustom({ name: 'A', slug: 'a', permissions: [] }));
    await run(() => service.cloneSystemRole({ systemRoleId: 's-1', name: 'B', slug: 'b' }));

    expect(writes.map((write) => write.actionKey)).toEqual(['role.created', 'role.created']);
    expect(writes.map((write) => write.targetId)).toEqual([CREATED_ROLE_ID, CREATED_ROLE_ID]);
  });

  it('labels archival as role.archived', async () => {
    const { service, writes, run } = build();

    await run(() => service.archiveCustom('r-1'));

    expect(writes[0].actionKey).toBe('role.archived');
  });

  it('records ownership transfer even though requireOwnerSession never calls requirePermission', async () => {
    const { service, contextService, writes, run } = build();
    const requirePermission = vi.spyOn(contextService, 'requirePermission');

    await run(() =>
      service.transferOwnership({
        sourceMemberId: 'm-src',
        recipientMemberId: 'm-dst',
        ownerRoleId: 'r-owner',
        sourceReplacementRoleId: 'r-plain',
      }),
    );

    expect(requirePermission).not.toHaveBeenCalled();
    expect(writes).toHaveLength(1);
    expect(writes[0].actionKey).toBe('organization.ownership-transferred');
  });

  it('records a transfer as one row targeting the recipient with the source in metadata', async () => {
    const { service, writes, run } = build();

    await run(() =>
      service.transferOwnership({
        sourceMemberId: 'm-src',
        recipientMemberId: 'm-dst',
        ownerRoleId: 'r-owner',
        sourceReplacementRoleId: 'r-plain',
      }),
    );

    expect(writes).toHaveLength(1);
    expect(writes[0].targetId).toBe('m-dst');
    expect(writes[0].metadata).toMatchObject({
      sourceMembershipId: 'm-src',
      sourceReplacementRoleId: 'r-plain',
    });
  });

  it('records owner grant and revoke with distinct action keys', async () => {
    const { service, writes, run } = build();

    await run(() => service.grantOwnerAccess('m-1', 'r-owner'));
    await run(() => service.revokeOwnerAccess('m-1', 'r-plain'));

    expect(writes.map((write) => write.actionKey)).toEqual([
      'organization.owner-granted',
      'organization.owner-revoked',
    ]);
  });

  it('marks every governance event as atomic evidence', async () => {
    const { service, writes, run } = build();

    await run(() => service.updatePermissions('r-1', ['device:read']));
    await run(() => service.grantOwnerAccess('m-1', 'r-owner'));

    for (const write of writes) {
      expect(write.tier).toBe('EVIDENCE');
      expect(write.durability).toBe('ATOMIC');
      expect(write.outcome).toBe('SUCCEEDED');
      expect(write.organizationId).toBe(ORG);
    }
  });

  it('carries the request provenance the tier 2 interceptor records', async () => {
    const { service, writes, run } = build();

    await run(() => service.archiveCustom('r-1'));

    expect(writes[0]).toMatchObject({
      method: 'POST',
      path: '/api/v1/organization/roles',
      ipAddress: '203.0.113.9',
      userAgent: 'vitest',
    });
  });

  it('labels permission changes and archival with the role name', async () => {
    const { service, writes, run } = build();

    await run(() => service.updatePermissions('r-1', ['device:read']));
    await run(() => service.archiveCustom('r-1'));

    expect(writes.map((write) => write.targetLabel)).toEqual(['Existing Role', 'Existing Role']);
  });

  it('attributes the acting session user', async () => {
    const { service, writes, run } = build();

    await run(() => service.assignToMember('m-1', 'r-1'));

    expect(writes[0]).toMatchObject({ actorType: 'UI', actorId: 'u-1', actorLabel: 'owner@example.com' });
  });

  it('supersedes the permission intent only after the mutation resolves', async () => {
    const { service, contextService, run } = build();
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await run(() => service.updatePermissions('r-1', ['device:read']));

    expect(finalize).toHaveBeenCalledOnce();
  });

  it('leaves the intent unfinalized when the mutation fails', async () => {
    const { service, contextService, rbacService, run } = build();
    rbacService.updateRolePermissions.mockRejectedValueOnce(new Error('db down'));
    const finalize = vi.spyOn(contextService, 'finalizeIntents');

    await run(() => service.updatePermissions('r-1', ['device:read']).catch(() => undefined));

    expect(finalize).not.toHaveBeenCalled();
  });

  it('leaves a denied intent behind when owner management is refused', async () => {
    const { service, contextService, rbacService, run } = build();
    rbacService.isOwnerCapable.mockReturnValue(false);
    let intents: PermissionIntent[] = [];

    await run(async () => {
      await service.grantOwnerAccess('m-1', 'r-owner').catch(() => undefined);
      intents = contextService.drainIntents();
      return undefined;
    });

    expect(intents).toEqual([
      expect.objectContaining({ resource: 'organization', action: 'manage-owners', denied: true }),
    ]);
  });

  it('supersedes the owner intent once the transfer commits', async () => {
    const { service, contextService, run } = build();
    let recorded = false;
    let pending: PermissionIntent[] = [];

    await run(async () => {
      await service.transferOwnership({
        sourceMemberId: 'm-src',
        recipientMemberId: 'm-dst',
        ownerRoleId: 'r-owner',
        sourceReplacementRoleId: 'r-plain',
      });
      recorded = contextService.hasRecordedIntents;
      pending = contextService.drainIntents();
      return undefined;
    });

    expect(recorded).toBe(true);
    expect(pending).toEqual([]);
  });

  it('still rejects an api-key caller from owner management', async () => {
    const { service, contextService, writes } = build();
    const apiKeyIdentity = { ...ownerIdentity(), authType: AuthType.ApiKey } as unknown as IdentityContext;

    await new Promise<void>((resolve) => {
      contextService.run({ requestId: 'r', identity: apiKeyIdentity }, () => {
        void expect(service.grantOwnerAccess('m-1', 'r-owner')).rejects.toThrow(ForbiddenException).then(resolve);
      });
    });

    expect(writes).toHaveLength(0);
  });
});
