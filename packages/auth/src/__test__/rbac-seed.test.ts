import { OrganizationMembershipRole, type PrismaClient } from '@repo/database';
import { vi } from 'vitest';

import { seedRbac } from '../rbac/seed';
import { requireSystemRoleId, type RbacConfig } from '../rbac/types';

const asPrisma = (mock: object) => mock as unknown as PrismaClient;

const hubConfig: RbacConfig = {
  permissions: [
    { resource: 'device', action: 'read', description: 'read' },
    { resource: 'device', action: 'write', description: 'write' },
  ],
  systemRoles: [
    {
      slug: 'member',
      name: 'Member',
      description: 'Member role',
      permissions: ['device:read', 'admin.servers:read'],
    },
  ],
};

function build(existingRole: { id: string } | null = null) {
  const upsert = vi.fn(async ({ create }: { create: { resource: string; action: string } }) => ({
    id: `perm-${create.resource}:${create.action}`,
    ...create,
  }));
  const findFirst = vi.fn().mockResolvedValue(existingRole);
  const roleCreate = vi.fn().mockResolvedValue({ id: 'role-new' });
  const roleUpdate = vi.fn().mockResolvedValue({ id: existingRole?.id ?? 'role-new' });
  const deleteMany = vi.fn();
  const rolePermCreate = vi.fn();
  const prisma = asPrisma({
    permission: { upsert },
    organizationMemberRole: { findFirst, create: roleCreate, update: roleUpdate },
    rolePermission: { deleteMany, create: rolePermCreate },
  });
  return { prisma, upsert, findFirst, roleCreate, roleUpdate, deleteMany, rolePermCreate };
}

describe('seedRbac hub-side seed safety (cannot clobber admin grants)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('upserts only its own catalog rows — never an admin-namespaced permission', async () => {
    const { prisma, upsert } = build();

    await seedRbac(prisma, hubConfig);

    expect(upsert).toHaveBeenCalledTimes(hubConfig.permissions.length);
    for (const [args] of upsert.mock.calls) {
      expect(args.create.resource.startsWith('admin.')).toBe(false);
      expect(
        hubConfig.permissions.some((p) => p.resource === args.create.resource && p.action === args.create.action),
      ).toBe(true);
    }
  });

  it('looks up and creates system roles only in the global scope (isSystem, organizationId: null)', async () => {
    const { prisma, findFirst, roleCreate } = build();

    await seedRbac(prisma, hubConfig);

    expect(findFirst).toHaveBeenCalledWith({
      where: { slug: 'member', isSystem: true, organizationId: null },
    });
    expect(roleCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ isSystem: true, organizationId: null }),
    });
  });

  it('rewrites grants only for the system role it resolved — org-scoped custom roles are untouched', async () => {
    const { prisma, deleteMany, rolePermCreate } = build({ id: 'role-member' });

    await seedRbac(prisma, hubConfig);

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledWith({ where: { roleId: 'role-member' } });
    for (const [args] of rolePermCreate.mock.calls) {
      expect(args.data.roleId).toBe('role-member');
    }
  });

  it('silently skips role grants for keys outside the seeded catalog', async () => {
    const { prisma, rolePermCreate } = build({ id: 'role-member' });

    await seedRbac(prisma, hubConfig);

    expect(rolePermCreate).toHaveBeenCalledTimes(1);
    expect(rolePermCreate).toHaveBeenCalledWith({
      data: { roleId: 'role-member', permissionId: 'perm-device:read' },
    });
  });
});

describe('requireSystemRoleId', () => {
  it('returns the only active global system role', async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: 'role-member' }]);
    const prisma = asPrisma({ organizationMemberRole: { findMany } });

    await expect(requireSystemRoleId(prisma, OrganizationMembershipRole.Member)).resolves.toBe('role-member');
    expect(findMany).toHaveBeenCalledWith({
      where: { slug: 'member', isSystem: true, organizationId: null, archivedAt: null },
      select: { id: true },
      take: 2,
    });
  });

  it.each([[[]], [[{ id: 'role-1' }, { id: 'role-2' }]]])(
    'fails closed for a missing or ambiguous seed',
    async (roles) => {
      const prisma = asPrisma({ organizationMemberRole: { findMany: vi.fn().mockResolvedValue(roles) } });
      await expect(requireSystemRoleId(prisma, OrganizationMembershipRole.Member)).rejects.toThrow(
        /unavailable or ambiguous/,
      );
    },
  );
});
