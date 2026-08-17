import { OrganizationMembershipRole } from '@repo/database';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { describe, expect, it, vi } from 'vitest';
import { OrganizationMembershipsRepository } from '../organization-members.repository';

const assignedRoleSelect = {
  id: true,
  name: true,
  slug: true,
  isSystem: true,
  rolePermissions: {
    select: { permission: { select: { resource: true, action: true } } },
  },
};

describe('OrganizationMembershipsRepository.delete', () => {
  it('soft-deletes by setting deletedAt instead of hard-deleting the row', async () => {
    const update = vi.fn().mockResolvedValue({});
    const del = vi.fn();
    const prisma = { member: { update, delete: del } } as unknown as PrismaClient;
    const repo = new OrganizationMembershipsRepository(prisma);

    await repo.delete('mem-1');

    expect(del).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mem-1' },
      data: { deletedAt: expect.any(Date) },
      include: {
        user: { select: { id: true, email: true, name: true, image: true } },
        organization: true,
        assignedRole: { select: assignedRoleSelect },
      },
    });
  });
});

describe('OrganizationMembershipsRepository.create', () => {
  it('upserts on (userId, organizationId) with the mandatory assigned role', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = { member: { upsert } } as unknown as PrismaClient;
    const repo = new OrganizationMembershipsRepository(prisma);

    await repo.create('org-1', 'user-1', OrganizationMembershipRole.Member, 'role-member');
    expect(upsert).toHaveBeenCalledWith({
      where: { userId_organizationId: { userId: 'user-1', organizationId: 'org-1' } },
      create: {
        organizationId: 'org-1',
        userId: 'user-1',
        role: OrganizationMembershipRole.Member,
        assignedRoleId: 'role-member',
      },
      update: { role: OrganizationMembershipRole.Member, assignedRoleId: 'role-member', deletedAt: null },
    });
  });

  it('fails closed when the requested system role seed is missing', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { organizationMemberRole: { findMany } } as unknown as PrismaClient;
    const repo = new OrganizationMembershipsRepository(prisma);

    await expect(repo.requireSystemRoleId(OrganizationMembershipRole.Member)).rejects.toThrow(
      'Required active system role "member"',
    );
  });
});

describe('OrganizationMembershipsRepository.updateRole', () => {
  it('guards deletedAt: null and dual-writes assignedRoleId from the seeded system role', async () => {
    const update = vi.fn().mockResolvedValue({});
    const findMany = vi.fn().mockResolvedValue([{ id: 'role-admin' }]);
    const prisma = { member: { update }, organizationMemberRole: { findMany } } as unknown as PrismaClient;
    const repo = new OrganizationMembershipsRepository(prisma);

    await repo.updateRole('mem-1', OrganizationMembershipRole.Admin);

    expect(findMany).toHaveBeenCalledWith({
      where: { slug: 'admin', isSystem: true, organizationId: null, archivedAt: null },
      select: { id: true },
      take: 2,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mem-1', deletedAt: null },
      data: { role: OrganizationMembershipRole.Admin, assignedRoleId: 'role-admin' },
      include: {
        user: { select: { id: true, email: true, name: true, image: true } },
        assignedRole: { select: assignedRoleSelect },
      },
    });
  });

  it('does not update when the system role seed is missing', async () => {
    const update = vi.fn().mockResolvedValue({});
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { member: { update }, organizationMemberRole: { findMany } } as unknown as PrismaClient;
    const repo = new OrganizationMembershipsRepository(prisma);

    await expect(repo.updateRole('mem-1', OrganizationMembershipRole.Admin)).rejects.toThrow(
      'Required active system role "admin"',
    );
    expect(update).not.toHaveBeenCalled();
  });
});

describe('OrganizationMembershipsRepository member-list user projection', () => {
  const redactedUserFields = ['role', 'banned', 'banReason', 'banExpires', 'emailVerified'];

  it('findByOrganizationId selects only public user fields and omits role/ban/emailVerified', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { member: { findMany } } as unknown as PrismaClient;
    const repo = new OrganizationMembershipsRepository(prisma);

    await repo.findByOrganizationId('org-1');

    expect(findMany).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', deletedAt: null },
      include: { user: { select: { id: true, email: true, name: true, image: true } } },
    });

    const userSelect = findMany.mock.calls[0][0].include.user.select;
    for (const field of redactedUserFields) {
      expect(userSelect).not.toHaveProperty(field);
    }
  });

  it('updateRole selects only public user fields and omits role/ban/emailVerified', async () => {
    const update = vi.fn().mockResolvedValue({});
    const findMany = vi.fn().mockResolvedValue([{ id: 'role-admin' }]);
    const prisma = { member: { update }, organizationMemberRole: { findMany } } as unknown as PrismaClient;
    const repo = new OrganizationMembershipsRepository(prisma);

    await repo.updateRole('mem-1', OrganizationMembershipRole.Admin);

    const userSelect = update.mock.calls[0][0].include.user.select;
    expect(userSelect).toEqual({ id: true, email: true, name: true, image: true });
    for (const field of redactedUserFields) {
      expect(userSelect).not.toHaveProperty(field);
    }
  });
});

describe('OrganizationMembershipsRepository owner-transfer eligibility', () => {
  it('filters before pagination and excludes the source membership', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(0);
    const prisma = { member: { findMany, count } } as unknown as PrismaClient;
    const repo = new OrganizationMembershipsRepository(prisma);

    await repo.findByOrganizationIdPaginated('org-1', {
      ownerTransferEligible: true,
      excludeMemberId: 'source-member',
      page: 2,
      pageSize: 20,
    });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          deletedAt: null,
          id: { not: 'source-member' },
          assignedRole: {
            rolePermissions: {
              none: {
                permission: {
                  resource: 'organization',
                  action: 'manage-owners',
                },
              },
            },
          },
          user: {
            OR: [{ banned: false }, { banExpires: { lte: expect.any(Date) } }],
          },
        },
        skip: 20,
        take: 20,
      }),
    );
    expect(count).toHaveBeenCalledWith({ where: findMany.mock.calls[0][0].where });
  });
});

describe('OrganizationMembershipsRepository.setDefaultOrganization', () => {
  it('returns null without clearing existing default when target membership is absent', async () => {
    const updateMany = vi.fn();
    const update = vi.fn();
    const findFirst = vi.fn().mockResolvedValue(null);
    const tx = { member: { findFirst, updateMany, update } };
    const prisma = { $transaction: (cb: (t: typeof tx) => unknown) => cb(tx) } as unknown as PrismaClient;
    const repo = new OrganizationMembershipsRepository(prisma);

    const result = await repo.setDefaultOrganization('user-1', 'org-1');

    expect(findFirst).toHaveBeenCalledWith({ where: { userId: 'user-1', organizationId: 'org-1', deletedAt: null } });
    expect(updateMany).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it('clears previous default then sets new one only after confirming target is live', async () => {
    const target = { id: 'mem-1', userId: 'user-1', organizationId: 'org-1', role: OrganizationMembershipRole.Member };
    const updated = { ...target, isDefaultOrg: true };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const update = vi.fn().mockResolvedValue(updated);
    const findFirst = vi.fn().mockResolvedValueOnce(target).mockResolvedValueOnce(updated);
    const tx = { member: { findFirst, updateMany, update } };
    const prisma = { $transaction: (cb: (t: typeof tx) => unknown) => cb(tx) } as unknown as PrismaClient;
    const repo = new OrganizationMembershipsRepository(prisma);

    const result = await repo.setDefaultOrganization('user-1', 'org-1');

    expect(findFirst).toHaveBeenNthCalledWith(1, {
      where: { userId: 'user-1', organizationId: 'org-1', deletedAt: null },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: { userId: 'user-1', isDefaultOrg: true },
      data: { isDefaultOrg: null },
    });
    expect(update).toHaveBeenCalledWith({ where: { id: 'mem-1' }, data: { isDefaultOrg: true } });
    expect(result).toEqual(updated);
  });
});
