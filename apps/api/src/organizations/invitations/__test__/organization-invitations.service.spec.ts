import { ForbiddenException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { OrganizationMembershipRole } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';
import { AuthType } from '../../../auth/identity-context';
import type { ContextService } from '../../../common/context/context.service';
import type { EmailService } from '../../../email/email.service';
import type { LoggerService } from '../../../logger/logger.service';
import type { InvitationWithAssignedRole } from '../organization-invitations.repository';
import { OrganizationInvitationsService } from '../organization-invitations.service';

const { Owner, Admin, Member } = OrganizationMembershipRole;

async function expectHttpStatus(p: Promise<unknown>, status: HttpStatus): Promise<void> {
  await p.then(
    () => {
      throw new Error(`expected the call to reject with HTTP ${status}, but it resolved`);
    },
    (err: unknown) => {
      if (!(err instanceof HttpException)) throw err;
      expect(err.getStatus()).toBe(status);
    },
  );
}

const roleSummaries = {
  owner: {
    id: 'role-owner',
    name: 'Owner',
    slug: 'owner',
    isSystem: true,
    isOwnerCapable: true,
    rolePermissions: [],
  },
  admin: {
    id: 'role-admin',
    name: 'Admin',
    slug: 'admin',
    isSystem: true,
    isOwnerCapable: false,
    rolePermissions: [],
  },
  member: {
    id: 'role-member',
    name: 'Member',
    slug: 'member',
    isSystem: true,
    isOwnerCapable: false,
    rolePermissions: [],
  },
  custom: {
    id: 'role-custom',
    name: 'Billing Manager',
    slug: 'billing-manager',
    isSystem: false,
    isOwnerCapable: false,
    rolePermissions: [],
  },
};

function invRow(over: Partial<InvitationWithAssignedRole> = {}): InvitationWithAssignedRole {
  return {
    id: 'inv-1',
    email: 'invitee@example.com',
    inviterId: 'u1',
    organizationId: 'org-1',
    assignedRoleId: roleSummaries.member.id,
    assignedRole: roleSummaries.member,
    status: 'pending',
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    ...over,
  };
}

function build(opts: {
  callerRole?: OrganizationMembershipRole;
  authType?: AuthType;
  email?: string;
  findById?: InvitationWithAssignedRole | null;
  findByIdAndOrg?: InvitationWithAssignedRole | null;
  existingMember?: unknown;
  pendingInvitation?: InvitationWithAssignedRole | null;
  pendingCount?: number;
  claimWins?: boolean;
  roleLookupError?: Error;
  assignmentError?: Error;
  actorPermissions?: ReadonlySet<string>;
  listedInvitations?: InvitationWithAssignedRole[];
  activeOrganization?: { name: string } | null;
}) {
  const tx = { transaction: true };
  const role = opts.callerRole ?? Owner;
  const repository = {
    findById: vi.fn().mockResolvedValue(opts.findById ?? null),
    findByIdAndOrganizationId: vi.fn().mockResolvedValue(opts.findByIdAndOrg ?? null),
    updateStatus: vi.fn().mockImplementation((id: string, status: string) => Promise.resolve(invRow({ id, status }))),
    findLiveMemberByEmail: vi.fn().mockResolvedValue(opts.existingMember ?? null),
    findPendingByEmailAndOrganization: vi.fn().mockResolvedValue(opts.pendingInvitation ?? null),
    countPendingByOrganization: vi.fn().mockResolvedValue(opts.pendingCount ?? 0),
    findActiveOrganizationName: vi
      .fn()
      .mockResolvedValue(opts.activeOrganization === undefined ? { name: 'Org' } : opts.activeOrganization),
    createInvitation: vi.fn().mockImplementation((data: object) => Promise.resolve(invRow(data))),
    claimPendingAsAccepted: vi.fn().mockResolvedValue(opts.claimWins ?? true),
    findByOrganizationIdPaginated: vi.fn().mockResolvedValue({
      data: opts.listedInvitations ?? [],
      meta: { page: 1, pageSize: 20, totalItems: opts.listedInvitations?.length ?? 0, totalPages: 1 },
    }),
  };
  const membershipsRepository = { create: vi.fn().mockResolvedValue({}) };
  const rbacService = {
    withOwnerLock: vi
      .fn()
      .mockImplementation((_organizationId: string, action: (client: object) => unknown) => action(tx)),
    getRoleById: vi.fn().mockImplementation(async (roleId: string) => {
      if (opts.roleLookupError) throw opts.roleLookupError;
      const role = Object.values(roleSummaries).find((candidate) => candidate.id === roleId);
      if (!role) throw new NotFoundException('Role not found');
      return role;
    }),
    assertRoleAssignableBy: vi
      .fn()
      .mockImplementation(
        (requestedRole: (typeof roleSummaries)[keyof typeof roleSummaries], actorPermissions: ReadonlySet<string>) => {
          if (opts.assignmentError) throw opts.assignmentError;
          if (requestedRole.isOwnerCapable && !actorPermissions.has('organization:manage-owners')) {
            throw new ForbiddenException('owner capability required');
          }
        },
      ),
  };
  const eventBus = { emit: vi.fn() };
  const ctx = {
    identity: { authType: opts.authType ?? AuthType.Session },
    role,
    organizationId: 'org-1',
    user: { firstName: 'A', lastName: 'B' },
    actingUser: { id: 'u1', email: opts.email ?? 'inviter@example.com', firstName: 'A', lastName: 'B' },
    userId: 'u1',
    email: opts.email ?? 'inviter@example.com',
    permissions:
      opts.actorPermissions ??
      (role === Owner ? new Set(['organization:manage-owners', 'invitation:create']) : new Set(['invitation:create'])),
    requirePermission: vi.fn((resource: string, action: string) => {
      if (role === Member) throw new ForbiddenException(`missing permission ${resource}:${action}`);
    }),
  } as unknown as ContextService;
  const emailService = {
    send: { organizationInvite: vi.fn().mockResolvedValue(undefined) },
  } as unknown as EmailService;
  const logger = { error: vi.fn() } as unknown as LoggerService;
  const service = new OrganizationInvitationsService(
    ctx,
    rbacService as never,
    emailService,
    eventBus as never,
    repository as never,
    membershipsRepository as never,
    logger,
  );
  return { service, repository, membershipsRepository, rbacService, eventBus, emailService, tx };
}

function invite(service: OrganizationInvitationsService, roleId: string) {
  return service.createInvitation({ email: 'invitee@example.com', roleId });
}

describe('OrganizationInvitationsService.createInvitation capability policy', () => {
  it('rejects a partial actor inviting an owner-capable role', async () => {
    const { service, repository } = build({ callerRole: Admin });
    await expect(invite(service, roleSummaries.owner.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects a Member inviting anyone', async () => {
    const { service, repository } = build({ callerRole: Member });
    await expect(invite(service, roleSummaries.member.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });

  it('allows an owner-capable actor inviting an ordinary role', async () => {
    const { service, repository } = build({ callerRole: Owner });
    await expect(invite(service, roleSummaries.admin.id)).resolves.toBeDefined();
    expect(repository.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ assignedRoleId: roleSummaries.admin.id }),
      expect.anything(),
    );
    expect(repository.createInvitation.mock.calls[0][0]).not.toHaveProperty('role');
  });

  it('allows an ordinary actor inviting a role within its permissions', async () => {
    const { service, repository } = build({ callerRole: Admin });
    await expect(invite(service, roleSummaries.member.id)).resolves.toBeDefined();
    expect(repository.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ assignedRoleId: roleSummaries.member.id }),
      expect.anything(),
    );
  });

  it('allows an owner-capable session inviting an owner-capable role', async () => {
    const { service, repository } = build({ callerRole: Owner });
    await expect(invite(service, roleSummaries.owner.id)).resolves.toBeDefined();
    expect(repository.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ assignedRoleId: roleSummaries.owner.id }),
      expect.anything(),
    );
  });

  it('accepts and persists a same-organization custom role ID', async () => {
    const { service, repository, rbacService } = build({ callerRole: Admin });
    await expect(invite(service, roleSummaries.custom.id)).resolves.toBeDefined();
    expect(rbacService.getRoleById).toHaveBeenCalledWith(roleSummaries.custom.id, 'org-1', expect.anything());
    expect(repository.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ assignedRoleId: roleSummaries.custom.id }),
      expect.anything(),
    );
  });

  it('rejects a custom role from another organization with the obscured not-found response', async () => {
    const { service, repository } = build({ roleLookupError: new NotFoundException('Role not found') });
    await expectHttpStatus(invite(service, 'other-org-role'), HttpStatus.NOT_FOUND);
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects a role whose permissions exceed the inviter permissions', async () => {
    const { service, repository } = build({
      assignmentError: new ForbiddenException('Cannot grant permissions you do not hold: billing:manage'),
    });
    await expect(invite(service, roleSummaries.custom.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects an unknown role with not found', async () => {
    const { service, repository } = build({});
    await expectHttpStatus(invite(service, 'missing-role'), HttpStatus.NOT_FOUND);
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });
});

describe('OrganizationInvitationsService.createInvitation duplicate/limit guards (Better Auth parity)', () => {
  it('normalizes the invitee email before lookup and storage', async () => {
    const { service, repository, tx } = build({});
    await service.createInvitation({ email: ' Invitee@Example.COM ', roleId: roleSummaries.member.id });
    expect(repository.findLiveMemberByEmail).toHaveBeenCalledWith('invitee@example.com', 'org-1', tx);
    expect(repository.findPendingByEmailAndOrganization).toHaveBeenCalledWith('invitee@example.com', 'org-1', tx);
    expect(repository.createInvitation).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'invitee@example.com' }),
      expect.anything(),
    );
  });

  it('rejects invitations for a soft-deleted organization', async () => {
    const { service, repository, rbacService } = build({ activeOrganization: null });
    await expectHttpStatus(invite(service, roleSummaries.member.id), HttpStatus.NOT_FOUND);
    expect(rbacService.getRoleById).not.toHaveBeenCalled();
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects inviting an existing live member with 400', async () => {
    const { service, repository } = build({ existingMember: { id: 'm1' } });
    await expectHttpStatus(invite(service, roleSummaries.member.id), HttpStatus.BAD_REQUEST);
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects a duplicate pending unexpired invitation with 400', async () => {
    const { service, repository } = build({ pendingInvitation: invRow() });
    await expectHttpStatus(invite(service, roleSummaries.member.id), HttpStatus.BAD_REQUEST);
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects when the pending-invitation limit is reached with 403', async () => {
    const { service, repository } = build({ pendingCount: 100 });
    await expectHttpStatus(invite(service, roleSummaries.member.id), HttpStatus.FORBIDDEN);
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });

  it('runs every data-dependent guard under the owner lock before role validation and insertion', async () => {
    const { service, repository, rbacService, tx } = build({});
    const order: string[] = [];
    rbacService.withOwnerLock.mockImplementation(
      async (_organizationId: string, action: (client: object) => unknown) => {
        order.push('lock');
        return action(tx);
      },
    );
    repository.findLiveMemberByEmail.mockImplementation(async () => {
      order.push('member');
      return null;
    });
    repository.findPendingByEmailAndOrganization.mockImplementation(async () => {
      order.push('duplicate');
      return null;
    });
    repository.countPendingByOrganization.mockImplementation(async () => {
      order.push('limit');
      return 0;
    });
    rbacService.getRoleById.mockImplementation(async () => {
      order.push('role');
      return roleSummaries.member;
    });
    repository.createInvitation.mockImplementation(async (data: object) => {
      order.push('insert');
      return invRow(data);
    });

    await invite(service, roleSummaries.member.id);

    expect(order).toEqual(['lock', 'member', 'duplicate', 'limit', 'role', 'insert']);
    expect(repository.findLiveMemberByEmail).toHaveBeenCalledWith('invitee@example.com', 'org-1', tx);
    expect(repository.findPendingByEmailAndOrganization).toHaveBeenCalledWith('invitee@example.com', 'org-1', tx);
    expect(repository.countPendingByOrganization).toHaveBeenCalledWith('org-1', tx);
  });

  it('fails a concurrent duplicate race closed after the first locked insert', async () => {
    const { service, repository, rbacService, tx } = build({});
    let pending = false;
    let lockTail = Promise.resolve();
    rbacService.withOwnerLock.mockImplementation((_organizationId: string, action: (client: object) => unknown) => {
      const result = lockTail.then(() => action(tx));
      lockTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    repository.findPendingByEmailAndOrganization.mockImplementation(async () => (pending ? invRow() : null));
    repository.createInvitation.mockImplementation(async (data: object) => {
      pending = true;
      return invRow(data);
    });

    const first = invite(service, roleSummaries.member.id);
    const second = invite(service, roleSummaries.member.id);

    await expect(first).resolves.toBeDefined();
    await expectHttpStatus(second, HttpStatus.BAD_REQUEST);
    expect(repository.createInvitation).toHaveBeenCalledTimes(1);
  });

  it('fails a concurrent limit race closed after the final allowed locked insert', async () => {
    const { service, repository, rbacService, tx } = build({});
    let pendingCount = 99;
    let lockTail = Promise.resolve();
    rbacService.withOwnerLock.mockImplementation((_organizationId: string, action: (client: object) => unknown) => {
      const result = lockTail.then(() => action(tx));
      lockTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    });
    repository.countPendingByOrganization.mockImplementation(async () => pendingCount);
    repository.createInvitation.mockImplementation(async (data: object) => {
      pendingCount += 1;
      return invRow(data);
    });

    const first = invite(service, roleSummaries.member.id);
    const second = invite(service, roleSummaries.member.id);

    await expect(first).resolves.toBeDefined();
    await expectHttpStatus(second, HttpStatus.FORBIDDEN);
    expect(repository.createInvitation).toHaveBeenCalledTimes(1);
  });
});

describe('OrganizationInvitationsService invitation projection', () => {
  it('returns the assigned role display name and ID', async () => {
    const { service } = build({
      findByIdAndOrg: invRow({
        assignedRoleId: roleSummaries.custom.id,
        assignedRole: roleSummaries.custom,
      }),
    });

    await expect(service.getInvitation('inv-1')).resolves.toEqual(
      expect.objectContaining({
        role: roleSummaries.custom.name,
        roleId: roleSummaries.custom.id,
      }),
    );
  });

  it('maps assigned roles returned by the organization invitation list', async () => {
    const { service } = build({
      listedInvitations: [
        invRow({
          assignedRoleId: roleSummaries.custom.id,
          assignedRole: roleSummaries.custom,
        }),
      ],
    });

    await expect(service.listInvitations({})).resolves.toEqual(
      expect.objectContaining({
        data: [expect.objectContaining({ role: roleSummaries.custom.name, roleId: roleSummaries.custom.id })],
      }),
    );
  });

  it('redacts role names and IDs outside the public catalog', async () => {
    const { service } = build({
      findByIdAndOrg: invRow({
        assignedRoleId: 'role-local-admin',
        assignedRole: {
          ...roleSummaries.custom,
          id: 'role-local-admin',
          name: 'Local Admin',
          rolePermissions: [{ permission: { resource: 'admin.users', action: 'read' } }],
        },
      }),
    });

    await expect(service.getInvitation('inv-1')).resolves.toEqual(
      expect.objectContaining({ role: 'Managed role', roleId: null }),
    );
  });
});

describe('OrganizationInvitationsService.acceptInvitation (invitee-scoped)', () => {
  it('claims the pending invitation, creates the member via the dual-writing memberships repo, emits member.added', async () => {
    const { service, repository, membershipsRepository, eventBus } = build({
      email: 'invitee@example.com',
      findById: invRow({
        assignedRoleId: roleSummaries.admin.id,
        assignedRole: roleSummaries.admin,
      }),
    });
    const result = await service.acceptInvitation('inv-1');
    expect(repository.claimPendingAsAccepted).toHaveBeenCalledWith('inv-1', expect.anything());
    expect(membershipsRepository.create).toHaveBeenCalledWith(
      'org-1',
      'u1',
      Member,
      roleSummaries.admin.id,
      expect.anything(),
    );
    expect(eventBus.emit).toHaveBeenCalledWith('member.added', expect.objectContaining({ userId: 'u1', role: Member }));
    expect(result.status).toBe('accepted');
    expect(result.roleId).toBe(roleSummaries.admin.id);
  });

  it('validates and persists an invitation RBAC role ID on the accepted membership', async () => {
    const { service, membershipsRepository, rbacService } = build({
      email: 'invitee@example.com',
      findById: invRow({
        assignedRoleId: roleSummaries.custom.id,
        assignedRole: roleSummaries.custom,
      }),
    });

    await service.acceptInvitation('inv-1');

    expect(rbacService.getRoleById).toHaveBeenCalledWith(roleSummaries.custom.id, 'org-1', expect.anything());
    expect(membershipsRepository.create).toHaveBeenCalledWith(
      'org-1',
      'u1',
      Member,
      roleSummaries.custom.id,
      expect.anything(),
    );
  });

  it('propagates current-role revalidation failure before claiming the invitation', async () => {
    const revalidationError = new NotFoundException('Role not found');
    const { service, repository } = build({
      email: 'invitee@example.com',
      findById: invRow(),
      roleLookupError: revalidationError,
    });

    await expect(service.acceptInvitation('inv-1')).rejects.toBe(revalidationError);
    expect(repository.claimPendingAsAccepted).not.toHaveBeenCalled();
  });

  it('rejects when the caller is already a live member — a stale invite must not become a role change', async () => {
    const { service, membershipsRepository, repository } = build({
      email: 'invitee@example.com',
      findById: invRow(),
      existingMember: { id: 'm1' },
    });
    await expectHttpStatus(service.acceptInvitation('inv-1'), HttpStatus.BAD_REQUEST);
    expect(membershipsRepository.create).not.toHaveBeenCalled();
    expect(repository.claimPendingAsAccepted).not.toHaveBeenCalled();
  });

  it('returns 409 without a member write when the pending claim loses a race (e.g. concurrent cancel)', async () => {
    const { service, membershipsRepository } = build({
      email: 'invitee@example.com',
      findById: invRow(),
      claimWins: false,
    });
    await expectHttpStatus(service.acceptInvitation('inv-1'), HttpStatus.CONFLICT);
    expect(membershipsRepository.create).not.toHaveBeenCalled();
  });

  it('relies on transaction rollback when the member write fails', async () => {
    const { service, repository, membershipsRepository, eventBus } = build({
      email: 'invitee@example.com',
      findById: invRow(),
    });
    membershipsRepository.create.mockRejectedValue(new Error('db down'));
    await expect(service.acceptInvitation('inv-1')).rejects.toThrow('db down');
    expect(repository.updateStatus).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('returns 404 (not 403) when the caller email does not match — anti-enumeration', async () => {
    const { service, membershipsRepository } = build({
      email: 'someone-else@example.com',
      findById: invRow(),
    });
    await expectHttpStatus(service.acceptInvitation('inv-1'), HttpStatus.NOT_FOUND);
    expect(membershipsRepository.create).not.toHaveBeenCalled();
  });

  it('returns 404 when the invitation does not exist', async () => {
    const { service } = build({ email: 'invitee@example.com', findById: null });
    await expectHttpStatus(service.acceptInvitation('missing'), HttpStatus.NOT_FOUND);
  });

  it('returns 404 when the authorized invitation is deleted before the locked reload', async () => {
    const { service, repository, membershipsRepository } = build({
      email: 'invitee@example.com',
      findById: invRow(),
    });
    repository.findById.mockResolvedValueOnce(invRow()).mockResolvedValueOnce(null);

    await expectHttpStatus(service.acceptInvitation('inv-1'), HttpStatus.NOT_FOUND);
    expect(membershipsRepository.create).not.toHaveBeenCalled();
  });

  it('rejects a non-pending invitation with 400', async () => {
    const { service, membershipsRepository } = build({
      email: 'invitee@example.com',
      findById: invRow({ status: 'canceled' }),
    });
    await expectHttpStatus(service.acceptInvitation('inv-1'), HttpStatus.BAD_REQUEST);
    expect(membershipsRepository.create).not.toHaveBeenCalled();
  });

  it('rejects an expired invitation with 400 without writing', async () => {
    const { service, membershipsRepository, repository } = build({
      email: 'invitee@example.com',
      findById: invRow({ expiresAt: new Date(Date.now() - 1_000) }),
    });
    await expectHttpStatus(service.acceptInvitation('inv-1'), HttpStatus.BAD_REQUEST);
    expect(membershipsRepository.create).not.toHaveBeenCalled();
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('accepts historical mixed-case invitations using a normalized caller email', async () => {
    const { service, membershipsRepository } = build({
      email: ' Invitee@Example.COM ',
      findById: invRow({ email: 'InViTeE@example.com' }),
    });
    await expect(service.acceptInvitation('inv-1')).resolves.toBeDefined();
    expect(membershipsRepository.create).toHaveBeenCalled();
  });
});

describe('OrganizationInvitationsService.rejectInvitation (invitee-scoped authz)', () => {
  it('returns 404 (not 403) when the caller email does not match — anti-enumeration', async () => {
    const { service, repository } = build({
      email: 'someone-else@example.com',
      findById: invRow({ email: 'invitee@example.com' }),
    });
    await expectHttpStatus(service.rejectInvitation('inv-1'), HttpStatus.NOT_FOUND);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('returns 404 when the invitation does not exist', async () => {
    const { service } = build({ email: 'invitee@example.com', findById: null });
    await expectHttpStatus(service.rejectInvitation('missing'), HttpStatus.NOT_FOUND);
  });

  it('returns 404 when the authorized invitation is deleted before the locked reload', async () => {
    const { service, repository } = build({
      email: 'invitee@example.com',
      findById: invRow(),
    });
    repository.findById.mockResolvedValueOnce(invRow()).mockResolvedValueOnce(null);

    await expectHttpStatus(service.rejectInvitation('inv-1'), HttpStatus.NOT_FOUND);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('rejects historical mixed-case invitations using a normalized caller email', async () => {
    const { service, repository } = build({
      email: ' Invitee@Example.COM ',
      findById: invRow({ email: 'InViTeE@example.com', status: 'pending' }),
    });
    const result = await service.rejectInvitation('inv-1');
    expect(result.status).toBe('rejected');
    expect(repository.updateStatus).toHaveBeenCalledWith('inv-1', 'rejected', expect.anything());
  });

  it('rejects a non-pending invitation with 400', async () => {
    const { service, repository } = build({
      email: 'invitee@example.com',
      findById: invRow({ email: 'invitee@example.com', status: 'accepted' }),
    });
    await expectHttpStatus(service.rejectInvitation('inv-1'), HttpStatus.BAD_REQUEST);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });
});

describe('OrganizationInvitationsService.cancelInvitation (inviter-scoped authz)', () => {
  it('blocks a non-privileged (Member) caller via requirePermission', async () => {
    const { service, repository } = build({ callerRole: Member, findByIdAndOrg: invRow() });
    await expect(service.cancelInvitation('inv-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('returns 404 for an invitation outside the caller org (org-scoped lookup)', async () => {
    const { service, repository } = build({ callerRole: Owner, findByIdAndOrg: null });
    await expectHttpStatus(service.cancelInvitation('inv-1'), HttpStatus.NOT_FOUND);
    expect(repository.findByIdAndOrganizationId).toHaveBeenCalledWith('inv-1', 'org-1');
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('cancels a pending in-org invitation for a privileged caller', async () => {
    const pending = invRow({ status: 'pending' });
    const { service, repository } = build({ callerRole: Admin, findByIdAndOrg: pending, findById: pending });
    const result = await service.cancelInvitation('inv-1');
    expect(result.status).toBe('canceled');
    expect(repository.updateStatus).toHaveBeenCalledWith('inv-1', 'canceled', expect.anything());
  });

  it('returns 404 when the authorized invitation is deleted before the locked reload', async () => {
    const pending = invRow({ status: 'pending' });
    const { service, repository } = build({ callerRole: Admin, findByIdAndOrg: pending, findById: null });

    await expectHttpStatus(service.cancelInvitation('inv-1'), HttpStatus.NOT_FOUND);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });

  it('retains 400 for an existing non-pending invitation after the locked reload', async () => {
    const pending = invRow({ status: 'pending' });
    const canceled = invRow({ status: 'canceled' });
    const { service, repository } = build({ callerRole: Admin, findByIdAndOrg: pending, findById: canceled });

    await expectHttpStatus(service.cancelInvitation('inv-1'), HttpStatus.BAD_REQUEST);
    expect(repository.updateStatus).not.toHaveBeenCalled();
  });
});

describe('OrganizationInvitationsService requireSessionAuth (API-key block)', () => {
  it('rejects createInvitation from an API-key caller with 403', async () => {
    const { service, repository } = build({ authType: AuthType.ApiKey, callerRole: Owner });
    await expectHttpStatus(
      service.createInvitation({ email: 'x@example.com', roleId: roleSummaries.member.id }),
      HttpStatus.FORBIDDEN,
    );
    expect(repository.createInvitation).not.toHaveBeenCalled();
  });

  it('rejects acceptInvitation from an API-key caller with 403', async () => {
    const { service, membershipsRepository } = build({ authType: AuthType.ApiKey });
    await expectHttpStatus(service.acceptInvitation('inv-1'), HttpStatus.FORBIDDEN);
    expect(membershipsRepository.create).not.toHaveBeenCalled();
  });
});
