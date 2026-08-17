import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@repo/database';
import { vi } from 'vitest';

import { RbacResolverService } from '../rbac/rbac-resolver.service';
import { RbacService } from '../rbac/rbac.service';
import type { RbacConfig } from '../rbac/types';

const asPrisma = (mock: object) => mock as unknown as PrismaClient;

const baseCatalog: RbacConfig = {
  permissions: [{ resource: 'device', action: 'read', description: '' }],
  systemRoles: [],
};

describe('RbacService create-path catalog fencing', () => {
  it('rejects creating a custom role granting an admin-namespaced key unknown to the base catalog', async () => {
    const create = vi.fn();
    const prisma = asPrisma({
      organizationMemberRole: { findUnique: vi.fn().mockResolvedValue(null), create },
    });
    const service = new RbacService(prisma, baseCatalog);

    await expect(
      service.createCustomRole(
        'org-1',
        { name: 'x', slug: 'x', permissions: ['admin.servers:read'] },
        new Set(['device:read', 'admin.servers:read']),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects cloning a template role the actor does not dominate', async () => {
    const $transaction = vi.fn();
    const template = {
      id: 'template',
      isSystem: true,
      organizationId: null,
      archivedAt: null,
      rolePermissions: [
        {
          permissionId: 'p-main',
          permission: { resource: 'device', action: 'read' },
        },
      ],
    };
    const prisma = asPrisma({
      organizationMemberRole: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(template),
      },
      $transaction,
    });
    const service = new RbacService(prisma, baseCatalog);

    await expect(
      service.createCustomRole(
        'org-1',
        { name: 'clone', slug: 'clone', permissions: [], templateId: template.id },
        new Set(),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect($transaction).not.toHaveBeenCalled();
  });
});

const visibleRole = {
  id: 'main-role',
  name: 'Main role',
  slug: 'main-role',
  description: null,
  isSystem: false,
  organizationId: 'org-1',
  templateId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  archivedAt: null,
  rolePermissions: [
    {
      id: 'rp-main',
      roleId: 'main-role',
      permissionId: 'p-main',
      permission: { id: 'p-main', resource: 'device', action: 'read', description: '' },
    },
  ],
  _count: { members: 0, invitations: 0 },
};

const hiddenRole = {
  ...visibleRole,
  id: 'admin-role',
  name: 'Local Admin',
  slug: 'local-admin',
  rolePermissions: [
    ...visibleRole.rolePermissions,
    {
      id: 'rp-admin',
      roleId: 'admin-role',
      permissionId: 'p-admin',
      permission: { id: 'p-admin', resource: 'admin.servers', action: 'read', description: '' },
    },
  ],
};

describe('RbacService role visibility fencing', () => {
  function serviceFor(role = hiddenRole, roles = [visibleRole, hiddenRole]) {
    const tx = {
      $executeRaw: vi.fn(),
      organizationMemberRole: {
        findMany: vi.fn().mockResolvedValue(roles),
        findUnique: vi.fn().mockResolvedValue(role),
      },
      member: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'member-1',
          userId: 'user-2',
          organizationId: 'org-1',
          deletedAt: null,
          assignedRole: visibleRole,
          user: { banned: false, banExpires: null },
        }),
        update: vi.fn(),
      },
    };
    const prisma = asPrisma({
      organizationMemberRole: tx.organizationMemberRole,
      $transaction: vi.fn((callback) => callback(tx)),
    });
    return new RbacService(prisma, baseCatalog);
  }

  it('filters out roles carrying any out-of-catalog permission without mutating the query result', async () => {
    const rows = [visibleRole, hiddenRole];
    const service = serviceFor(hiddenRole, rows);
    await expect(service.listOrganizationRoles('org-1')).resolves.toEqual([
      expect.objectContaining({ id: visibleRole.id }),
    ]);
    expect(rows).toHaveLength(2);
  });

  it('returns the same not-found response for hidden role detail and guessed mutation IDs', async () => {
    const service = serviceFor();
    await expect(service.getRoleById(hiddenRole.id, 'org-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.assignRoleToMember('org-1', 'member-1', hiddenRole.id, {
        userId: 'actor',
        permissions: new Set(['device:read']),
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.cloneSystemRole('org-1', hiddenRole.id, 'clone', 'clone', new Set(['device:read'])),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.updateRolePermissions(hiddenRole.id, ['device:read'], 'org-1', new Set(['device:read'])),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.updateCustomRoleMetadata(hiddenRole.id, 'org-1', { name: 'hidden' }, new Set(['device:read'])),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.archiveCustomRole(hiddenRole.id, 'org-1', new Set(['device:read']))).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects a hidden role ID supplied through the custom-role template field', async () => {
    const create = vi.fn();
    const service = new RbacService(
      asPrisma({
        organizationMemberRole: {
          findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(hiddenRole),
          create,
        },
      }),
      baseCatalog,
    );

    await expect(
      service.createCustomRole(
        'org-1',
        {
          name: 'role',
          slug: 'role',
          permissions: ['device:read'],
          templateId: hiddenRole.id,
        },
        new Set(['device:read']),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(create).not.toHaveBeenCalled();
  });

  it('allows the composed catalog instance to see the same role', async () => {
    const composed = new RbacService(
      asPrisma({
        organizationMemberRole: {
          findMany: vi.fn().mockResolvedValue([visibleRole, hiddenRole]),
          findUnique: vi.fn().mockResolvedValue(hiddenRole),
        },
      }),
      {
        permissions: [...baseCatalog.permissions, { resource: 'admin.servers', action: 'read', description: '' }],
        systemRoles: [],
      },
    );
    await expect(composed.getRoleById(hiddenRole.id, 'org-1')).resolves.toEqual(
      expect.objectContaining({ id: hiddenRole.id }),
    );
  });
});

describe('RbacResolverService catalog fencing', () => {
  it('returns only permissions configured for that application instance', async () => {
    const resolver = new RbacResolverService(
      asPrisma({
        rolePermission: {
          findMany: vi
            .fn()
            .mockResolvedValue([
              { permission: { resource: 'device', action: 'read' } },
              { permission: { resource: 'admin.servers', action: 'read' } },
            ]),
        },
      }),
      baseCatalog,
    );

    await expect(resolver.resolveEffectivePermissions(hiddenRole.id)).resolves.toEqual(new Set(['device:read']));
  });
});

describe('RbacService role archival', () => {
  function buildRole(overrides: Record<string, unknown> = {}) {
    const update = vi.fn().mockResolvedValue({ ...visibleRole, archivedAt: new Date() });
    const tx = {
      $executeRaw: vi.fn(),
      organizationMemberRole: {
        findUnique: vi.fn().mockResolvedValue({ ...visibleRole, ...overrides }),
        update,
      },
    };
    const service = new RbacService(asPrisma({ $transaction: vi.fn((callback) => callback(tx)) }), baseCatalog);
    return { service, tx, update };
  }

  it('archives an unused custom role while ignoring deleted members and historical or expired invitations', async () => {
    const { service, tx, update } = buildRole();

    await expect(service.archiveCustomRole(visibleRole.id, 'org-1', new Set(['device:read']))).resolves.toEqual(
      expect.objectContaining({ archivedAt: expect.any(Date) }),
    );
    expect(tx.organizationMemberRole.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          _count: {
            select: {
              members: { where: { organizationId: 'org-1', deletedAt: null } },
              invitations: {
                where: {
                  organizationId: 'org-1',
                  status: 'pending',
                  expiresAt: { gt: expect.any(Date) },
                },
              },
            },
          },
        }),
      }),
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: visibleRole.id },
      data: { archivedAt: expect.any(Date) },
    });
  });

  it.each([
    ['active members', { members: 1, invitations: 0 }],
    ['pending unexpired invitations', { members: 0, invitations: 1 }],
  ])('blocks archival while %s reference the role', async (_label, counts) => {
    const { service, update } = buildRole({ _count: counts });
    await expect(service.archiveCustomRole(visibleRole.id, 'org-1', new Set(['device:read']))).rejects.toThrow(
      BadRequestException,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('blocks archival when the actor does not dominate the existing role', async () => {
    const { service, update } = buildRole();

    await expect(service.archiveCustomRole(visibleRole.id, 'org-1', new Set())).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('blocks system roles and hides already archived roles', async () => {
    await expect(
      buildRole({ isSystem: true, organizationId: null }).service.archiveCustomRole(
        visibleRole.id,
        'org-1',
        new Set(['device:read']),
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      buildRole({ archivedAt: new Date() }).service.archiveCustomRole(
        visibleRole.id,
        'org-1',
        new Set(['device:read']),
      ),
    ).rejects.toThrow(NotFoundException);
  });
});
