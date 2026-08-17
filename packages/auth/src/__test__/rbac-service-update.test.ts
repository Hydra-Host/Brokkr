import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { PrismaClient } from '@repo/database';
import { vi } from 'vitest';

import { RbacService } from '../rbac/rbac.service';
import type { RbacConfig } from '../rbac/types';

const ORG = 'org-1';
const asPrisma = (mock: object) => mock as unknown as PrismaClient;

const baseCatalog: RbacConfig = {
  permissions: [
    { resource: 'device', action: 'read', description: '' },
    { resource: 'device', action: 'write', description: '' },
  ],
  systemRoles: [],
};
const composedCatalog: RbacConfig = {
  permissions: [...baseCatalog.permissions, { resource: 'ext.servers', action: 'read', description: '' }],
  systemRoles: [],
};

const existingGrants = [
  { permissionId: 'p-read', permission: { resource: 'device', action: 'read' } },
  { permissionId: 'p-ext', permission: { resource: 'ext.servers', action: 'read' } },
];

const build = (
  config: RbacConfig,
  resolvedRecords: object[] = [{ id: 'p-write', resource: 'device', action: 'write' }],
  rolePermissions: typeof existingGrants = [],
  isSystem = false,
  roleOrganizationId: string | null = ORG,
) => {
  const deleteMany = vi.fn();
  const createMany = vi.fn();
  const role = {
    id: 'r',
    archivedAt: null,
    isSystem,
    organizationId: roleOrganizationId,
    rolePermissions,
    _count: { members: 0, invitations: 0 },
  };
  const update = vi.fn().mockResolvedValue(role);
  const txFindUnique = vi.fn().mockResolvedValue(role);
  const tx = {
    $executeRaw: vi.fn(),
    organizationMemberRole: {
      findUnique: txFindUnique,
      update,
    },
    rolePermission: {
      findMany: vi.fn().mockResolvedValue(existingGrants),
      deleteMany,
      createMany,
    },
  };
  const $transaction = vi.fn(async (cb: (tx_: unknown) => Promise<unknown>) => cb(tx));
  const prisma = asPrisma({
    organizationMemberRole: {
      findUnique: vi.fn().mockResolvedValue(role),
      update,
    },
    permission: {
      findMany: vi.fn().mockResolvedValue(resolvedRecords),
    },
    $transaction,
  });
  return { service: new RbacService(prisma, config), deleteMany, createMany, update, txFindUnique, $transaction };
};

describe('RbacService.updateRolePermissions catalog-scoped replacement', () => {
  const actor = new Set(['device:read', 'device:write']);

  it('preserves grants outside the configured catalog while replacing in-catalog ones', async () => {
    const { service, deleteMany, createMany } = build(baseCatalog);
    await service.updateRolePermissions('r', ['device:write'], ORG, actor);
    expect(deleteMany).toHaveBeenCalledWith({ where: { roleId: 'r', permissionId: { in: ['p-read'] } } });
    expect(createMany).toHaveBeenCalledWith({
      data: [{ roleId: 'r', permissionId: 'p-write' }],
      skipDuplicates: true,
    });
  });

  it('still rejects incoming keys unknown to the configured catalog', async () => {
    const { service, $transaction } = build(baseCatalog);
    await expect(service.updateRolePermissions('r', ['ext.servers:read'], ORG, actor)).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.updateRolePermissions('r', ['bogus:key'], ORG, actor)).rejects.toThrow(
      /Invalid permission key/,
    );
    expect($transaction).not.toHaveBeenCalled();
  });

  it('replaces every existing grant when the catalog covers them all (composed-catalog instance)', async () => {
    const { service, deleteMany, createMany } = build(composedCatalog);
    await service.updateRolePermissions('r', ['device:write'], ORG, actor);
    expect(deleteMany).toHaveBeenCalledWith({ where: { roleId: 'r', permissionId: { in: ['p-read', 'p-ext'] } } });
    expect(createMany).toHaveBeenCalledWith({
      data: [{ roleId: 'r', permissionId: 'p-write' }],
      skipDuplicates: true,
    });
  });

  it('an empty incoming set clears in-catalog grants but keeps out-of-catalog ones', async () => {
    const { service, deleteMany, createMany } = build(baseCatalog, []);
    await service.updateRolePermissions('r', [], ORG, actor);
    expect(deleteMany).toHaveBeenCalledWith({ where: { roleId: 'r', permissionId: { in: ['p-read'] } } });
    expect(createMany).toHaveBeenCalledWith({ data: [], skipDuplicates: true });
  });

  it('rejects downgrading a role that the actor does not already dominate', async () => {
    const { service, $transaction } = build(
      baseCatalog,
      [],
      [
        { permissionId: 'p-read', permission: { resource: 'device', action: 'read' } },
        { permissionId: 'p-write', permission: { resource: 'device', action: 'write' } },
      ],
    );

    await expect(service.updateRolePermissions('r', ['device:read'], ORG, new Set(['device:read']))).rejects.toThrow(
      ForbiddenException,
    );
    expect($transaction).not.toHaveBeenCalled();
  });

  it('rejects ordinary-to-owner permission updates', async () => {
    const ownerCatalog: RbacConfig = {
      permissions: [...baseCatalog.permissions, { resource: 'organization', action: 'manage-owners', description: '' }],
      systemRoles: [],
    };
    const { service, $transaction } = build(
      ownerCatalog,
      [
        { id: 'p-read', resource: 'device', action: 'read' },
        { id: 'p-write', resource: 'device', action: 'write' },
        { id: 'p-owner', resource: 'organization', action: 'manage-owners' },
      ],
      [{ permissionId: 'p-read', permission: { resource: 'device', action: 'read' } }],
    );

    await expect(
      service.updateRolePermissions(
        'r',
        ['device:read', 'device:write', 'organization:manage-owners'],
        ORG,
        new Set(['device:read', 'device:write', 'organization:manage-owners']),
      ),
    ).rejects.toThrow('Role owner capability can only change through dedicated owner-management flows');
    expect($transaction).not.toHaveBeenCalled();
  });

  it('rejects owner-to-ordinary permission updates', async () => {
    const ownerCatalog: RbacConfig = {
      permissions: [...baseCatalog.permissions, { resource: 'organization', action: 'manage-owners', description: '' }],
      systemRoles: [],
    };
    const ownerPermissions = [
      { permissionId: 'p-read', permission: { resource: 'device', action: 'read' } },
      { permissionId: 'p-write', permission: { resource: 'device', action: 'write' } },
      { permissionId: 'p-owner', permission: { resource: 'organization', action: 'manage-owners' } },
    ];
    const { service, $transaction } = build(
      ownerCatalog,
      [
        { id: 'p-read', resource: 'device', action: 'read' },
        { id: 'p-write', resource: 'device', action: 'write' },
      ],
      ownerPermissions,
    );

    await expect(
      service.updateRolePermissions(
        'r',
        ['device:read', 'device:write'],
        ORG,
        new Set(['device:read', 'device:write', 'organization:manage-owners']),
      ),
    ).rejects.toThrow('Role owner capability can only change through dedicated owner-management flows');
    expect($transaction).not.toHaveBeenCalled();
  });

  it('rejects metadata changes to a role the actor does not dominate', async () => {
    const { service, update } = build(
      baseCatalog,
      [],
      [{ permissionId: 'p-write', permission: { resource: 'device', action: 'write' } }],
    );

    await expect(
      service.updateCustomRoleMetadata('r', ORG, { name: 'Downgraded' }, new Set(['device:read'])),
    ).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('updates custom-role metadata and returns the transaction-scoped refreshed role', async () => {
    const rolePermissions = [{ permissionId: 'p-read', permission: { resource: 'device', action: 'read' } }];
    const { service, update, txFindUnique, $transaction } = build(baseCatalog, [], rolePermissions);

    const result = await service.updateCustomRoleMetadata(
      'r',
      ORG,
      { name: 'Renamed', description: 'Updated' },
      new Set(['device:read']),
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: 'r' },
      data: { name: 'Renamed', description: 'Updated' },
      include: {
        rolePermissions: { include: { permission: true } },
        _count: {
          select: {
            members: { where: { organizationId: ORG, deletedAt: null } },
            invitations: {
              where: { organizationId: ORG, status: 'pending', expiresAt: { gt: expect.any(Date) } },
            },
          },
        },
      },
    });
    expect(txFindUnique).toHaveBeenCalledWith({
      where: { id: 'r' },
      select: {
        id: true,
        archivedAt: true,
        isSystem: true,
        organizationId: true,
        rolePermissions: {
          select: {
            permissionId: true,
            permission: { select: { resource: true, action: true } },
          },
        },
      },
    });
    expect(txFindUnique).toHaveBeenCalledTimes(1);
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ id: 'r', isSystem: false }));
  });

  it('rejects metadata changes to system roles before writing', async () => {
    const rolePermissions = [{ permissionId: 'p-read', permission: { resource: 'device', action: 'read' } }];
    const { service, update } = build(baseCatalog, [], rolePermissions, true, null);

    await expect(
      service.updateCustomRoleMetadata('r', ORG, { name: 'Renamed' }, new Set(['device:read'])),
    ).rejects.toThrow('System roles cannot be modified');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('RbacService.updateRolePermissionsAndMetadata atomicity', () => {
  const actor = new Set(['device:read', 'device:write']);

  it('replaces permissions and updates metadata inside a single transaction', async () => {
    const rolePermissions = [{ permissionId: 'p-read', permission: { resource: 'device', action: 'read' } }];
    const { service, deleteMany, createMany, update, $transaction } = build(baseCatalog, undefined, rolePermissions);

    await service.updateRolePermissionsAndMetadata('r', ORG, { permissions: ['device:write'], name: 'Renamed' }, actor);

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { roleId: 'r', permissionId: { in: ['p-read'] } } });
    expect(createMany).toHaveBeenCalledWith({
      data: [{ roleId: 'r', permissionId: 'p-write' }],
      skipDuplicates: true,
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r' }, data: { name: 'Renamed' } }));
  });

  it('skips the permission replace entirely when only metadata changes', async () => {
    const rolePermissions = [{ permissionId: 'p-read', permission: { resource: 'device', action: 'read' } }];
    const { service, deleteMany, createMany } = build(baseCatalog, undefined, rolePermissions);

    await service.updateRolePermissionsAndMetadata('r', ORG, { description: 'Updated' }, actor);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(createMany).not.toHaveBeenCalled();
  });

  it('rejects the whole update when the actor cannot manage the role, before any write', async () => {
    const { service, $transaction } = build(
      baseCatalog,
      [{ id: 'p-read', resource: 'device', action: 'read' }],
      [
        { permissionId: 'p-read', permission: { resource: 'device', action: 'read' } },
        { permissionId: 'p-write', permission: { resource: 'device', action: 'write' } },
      ],
    );

    await expect(
      service.updateRolePermissionsAndMetadata(
        'r',
        ORG,
        { permissions: ['device:read'], name: 'Renamed' },
        new Set(['device:read']),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});
