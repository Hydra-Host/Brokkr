import { HttpStatus } from '@nestjs/common';
import { OrganizationMembershipRole } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';

import { OrganizationMembershipsService } from '../organization-members.service';

const assignedRole = {
  id: 'role-reader',
  name: 'Reader',
  slug: 'reader',
  isSystem: false,
  rolePermissions: [{ permission: { resource: 'member', action: 'read' } }],
};

function build(membership: object | null = { id: 'member-1', userId: 'target', assignedRole }) {
  const deleted = {
    id: 'member-1',
    userId: 'target',
    organizationId: 'org-1',
    role: OrganizationMembershipRole.Member,
    assignedRoleId: assignedRole.id,
    assignedRole,
    user: { email: 'target@example.com' },
  };
  const repo = {
    findByIdAndOrganizationId: vi.fn().mockResolvedValue(membership ?? null),
    requireSystemRoleId: vi.fn().mockResolvedValue('role-admin'),
    delete: vi.fn().mockResolvedValue(deleted),
    setDefaultOrganization: vi.fn(),
  };
  const context = {
    organizationId: 'org-1',
    userId: 'actor',
    requestId: 'req-1',
    permissions: new Set(['member:read', 'member:delete', 'member:change-role']),
    requirePermission: vi.fn(),
    pushIntent: vi.fn().mockReturnValue('intent-1'),
    finalizeIntents: vi.fn(),
    actorFields: vi.fn().mockReturnValue({
      actorType: 'UI',
      actorId: 'actor',
      actorLabel: 'actor@example.com',
      apiKeyId: null,
      apiKeyLabel: null,
    }),
    requestFields: vi.fn().mockReturnValue({ method: null, path: null, ipAddress: null, userAgent: null }),
    buildAuditPayload: vi.fn().mockReturnValue({
      triggeredBy: 'actor',
      triggeredByEmail: 'actor@example.com',
      organizationId: 'org-1',
    }),
  };
  const rbac = {
    assertOrdinaryMemberActionAllowed: vi.fn(),
    assignRoleToMember: vi.fn(),
  };
  const eventBus = { emit: vi.fn() };
  const eventLog = { recordInTransaction: vi.fn() };
  const tx = {};
  const prisma = { $transaction: vi.fn((fn: (client: unknown) => unknown) => fn(tx)) };
  const logger = { log: vi.fn() };
  const service = new OrganizationMembershipsService(
    repo as never,
    context as never,
    rbac as never,
    eventBus as never,
    eventLog as never,
    prisma as never,
    logger as never,
  );
  return { service, repo, context, rbac, eventBus, eventLog, prisma, tx, logger };
}

describe('OrganizationMembershipsService', () => {
  it('returns 404 for a member outside the active organization', async () => {
    const { service, repo } = build(null);
    await expect(service.removeOrganizationMembership('missing')).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
    });
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('applies shared dominance policy before removal and writes an audit event', async () => {
    const { service, repo, context, rbac, eventBus, logger } = build();
    await service.removeOrganizationMembership('member-1');
    expect(context.requirePermission).toHaveBeenCalledWith('member', 'delete');
    expect(rbac.assertOrdinaryMemberActionAllowed).toHaveBeenCalledWith(
      { userId: 'actor', permissions: context.permissions },
      expect.objectContaining({ userId: 'target' }),
    );
    expect(repo.delete).toHaveBeenCalledWith('member-1', expect.anything());
    expect(eventBus.emit).toHaveBeenCalledWith('member.removed', expect.objectContaining({ userId: 'target' }));
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('actor@example.com'));
  });

  it('propagates removal-policy rejection without deleting or emitting', async () => {
    const { service, repo, rbac, eventBus } = build();
    rbac.assertOrdinaryMemberActionAllowed.mockImplementation(() => {
      throw new Error('policy rejected');
    });

    await expect(service.removeOrganizationMembership('member-1')).rejects.toThrow('policy rejected');

    expect(repo.delete).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('allows self-removal of an ordinary assigned role without delete permission', async () => {
    const { service, context, repo } = build({
      id: 'member-1',
      userId: 'actor',
      assignedRole,
    });

    await service.removeOrganizationMembership('member-1');

    expect(context.requirePermission).not.toHaveBeenCalledWith('member', 'delete');
    expect(repo.delete).toHaveBeenCalledWith('member-1', expect.anything());
  });

  it('delegates the legacy enum endpoint to the ordinary RBAC assignment path', async () => {
    const { service, repo, context, rbac } = build();
    await service.updateOrganizationMembershipRole('member-1', { role: OrganizationMembershipRole.Admin });
    expect(repo.requireSystemRoleId).toHaveBeenCalledWith(OrganizationMembershipRole.Admin);
    expect(rbac.assignRoleToMember).toHaveBeenCalledWith(
      'org-1',
      'member-1',
      'role-admin',
      { userId: 'actor', permissions: context.permissions },
      expect.any(Function),
    );
  });

  it('redacts private-catalog assigned-role metadata from member projections', async () => {
    const hiddenRole = {
      ...assignedRole,
      id: 'role-local-admin',
      name: 'Local Admin',
      rolePermissions: [{ permission: { resource: 'admin.users', action: 'read' } }],
    };
    const { service } = build({
      id: 'member-1',
      userId: 'target',
      organizationId: 'org-1',
      role: OrganizationMembershipRole.Member,
      assignedRoleId: hiddenRole.id,
      assignedRole: hiddenRole,
    });

    await expect(
      service.updateOrganizationMembershipRole('member-1', { role: OrganizationMembershipRole.Admin }),
    ).resolves.toMatchObject({ role: 'Managed role', assignedRoleId: null });
  });
});
