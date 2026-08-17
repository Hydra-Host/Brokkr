import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { RbacService, type RbacConfig } from '@repo/auth/rbac';
import type { PrismaClient } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';

const ORG = 'org-1';
const OWNER_KEY = 'organization:manage-owners';
const catalog: RbacConfig = {
  permissions: [
    { resource: 'organization', action: 'manage-owners', description: '', audit: 'mutating' },
    { resource: 'member', action: 'read', description: '', audit: 'read-only' },
    { resource: 'member', action: 'change-role', description: '', audit: 'mutating' },
  ],
  systemRoles: [],
};
const ownerPermissions = new Set([OWNER_KEY, 'member:read', 'member:change-role']);
const managerPermissions = new Set(['member:read', 'member:change-role']);
const readerPermissions = new Set(['member:read']);

function role(id: string, permissions: string[], organizationId: string | null = null) {
  const archivedAt: Date | null = null;
  return {
    id,
    name: id,
    slug: id,
    description: null,
    isSystem: organizationId === null,
    organizationId,
    templateId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    archivedAt,
    rolePermissions: permissions.map((key, index) => {
      const [resource, action] = key.split(':');
      return {
        id: `rp-${id}-${index}`,
        roleId: id,
        permissionId: `p-${key}`,
        permission: {
          id: `p-${key}`,
          resource,
          action,
          description: null,
          createdAt: new Date(),
        },
      };
    }),
  };
}

function member(
  id: string,
  userId: string,
  assignedRole: ReturnType<typeof role>,
  organizationId = ORG,
  deletedAt: Date | null = null,
  banned = false,
) {
  return {
    id,
    userId,
    organizationId,
    assignedRoleId: assignedRole.id,
    assignedRole,
    role: 'Member',
    isDefaultOrg: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt,
    user: { banned, banExpires: null },
  };
}

function asPrisma(value: object): PrismaClient {
  return value as unknown as PrismaClient;
}

describe('RbacService ordinary assignment policy', () => {
  function build(target: ReturnType<typeof member> | null, proposed: ReturnType<typeof role> | null) {
    const update = vi.fn().mockResolvedValue(target);
    const tx = {
      $executeRaw: vi.fn(),
      member: { findUnique: vi.fn().mockResolvedValue(target), update },
      organizationMemberRole: { findUnique: vi.fn().mockResolvedValue(proposed) },
    };
    const $transaction = vi.fn((callback) => callback(tx));
    const prisma = asPrisma({ $transaction });
    return { service: new RbacService(prisma, catalog), update, tx, $transaction };
  }

  it('allows a strict permission superset to modify a subset', async () => {
    const target = member('member-1', 'target', role('reader', ['member:read']));
    const { service, update } = build(target, role('reader-2', ['member:read']));
    await service.assignRoleToMember(ORG, target.id, 'reader-2', {
      userId: 'actor',
      permissions: managerPermissions,
    });
    expect(update).toHaveBeenCalled();
  });

  it.each([
    ['equal', readerPermissions, ['member:read']],
    ['incomparable', new Set(['member:change-role']), ['member:read']],
    ['subset', readerPermissions, ['member:read', 'member:change-role']],
  ])('denies %s permission sets', async (_name, actorPermissions, targetKeys) => {
    const target = member('member-1', 'target', role('target-role', targetKeys));
    const { service, update } = build(target, role('reader', ['member:read']));
    await expect(
      service.assignRoleToMember(ORG, target.id, 'reader', {
        userId: 'actor',
        permissions: actorPermissions,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows a non-owner self-change without strict dominance', async () => {
    const target = member('member-1', 'actor', role('manager', Array.from(managerPermissions)));
    const { service, update } = build(target, role('reader', ['member:read']));
    await service.assignRoleToMember(ORG, target.id, 'reader', {
      userId: 'actor',
      permissions: managerPermissions,
    });
    expect(update).toHaveBeenCalled();
  });

  it('rejects current and proposed owner-capable roles', async () => {
    const owner = role('owner', Array.from(ownerPermissions));
    await expect(
      build(member('member-1', 'target', owner), role('reader', ['member:read'])).service.assignRoleToMember(
        ORG,
        'member-1',
        'reader',
        { userId: 'actor', permissions: ownerPermissions },
      ),
    ).rejects.toThrow(/owner-management/);
    await expect(
      build(member('member-1', 'target', role('reader', ['member:read'])), owner).service.assignRoleToMember(
        ORG,
        'member-1',
        'owner',
        { userId: 'actor', permissions: ownerPermissions },
      ),
    ).rejects.toThrow(/owner-management/);
  });

  it('rejects an archived role assignment', async () => {
    const target = member('member-1', 'target', role('reader', ['member:read']));
    const archived = { ...role('archived', ['member:read'], ORG), archivedAt: new Date() };
    const { service, update } = build(target, archived);

    await expect(
      service.assignRoleToMember(ORG, target.id, archived.id, {
        userId: 'actor',
        permissions: managerPermissions,
      }),
    ).rejects.toThrow(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });

  it('loads, validates, and updates only after acquiring one owner lock', async () => {
    const target = member('member-1', 'target', role('reader', ['member:read']));
    const proposed = role('reader-2', ['member:read']);
    const { service, tx, $transaction } = build(target, proposed);

    await service.assignRoleToMember(ORG, target.id, proposed.id, {
      userId: 'actor',
      permissions: managerPermissions,
    });

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.member.findUnique.mock.invocationCallOrder[0]);
    expect(tx.member.update.mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.organizationMemberRole.findUnique.mock.invocationCallOrder[0],
    );
  });

  it('cannot overwrite an owner transition completed before its locked reload', async () => {
    const owner = role('owner', Array.from(ownerPermissions));
    const target = member('member-1', 'target', role('reader', ['member:read']));
    const proposed = role('reader-2', ['member:read']);
    const update = vi.fn();
    const tx = {
      $executeRaw: vi.fn().mockImplementation(() => {
        target.assignedRole = owner;
        return Promise.resolve();
      }),
      member: { findUnique: vi.fn().mockImplementation(() => Promise.resolve(target)), update },
      organizationMemberRole: { findUnique: vi.fn().mockResolvedValue(proposed) },
    };
    const $transaction = vi.fn((callback) => callback(tx));
    const service = new RbacService(asPrisma({ $transaction }), catalog);

    await expect(
      service.assignRoleToMember(ORG, target.id, proposed.id, {
        userId: 'actor',
        permissions: ownerPermissions,
      }),
    ).rejects.toThrow(/owner-management/);

    expect($transaction).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it('fails closed for missing, deleted, and cross-org members', async () => {
    const proposed = role('reader', ['member:read']);
    await expect(
      build(null, proposed).service.assignRoleToMember(ORG, 'missing', proposed.id, {
        userId: 'actor',
        permissions: managerPermissions,
      }),
    ).rejects.toThrow(NotFoundException);
    await expect(
      build(member('member-1', 'target', proposed, 'other-org'), proposed).service.assignRoleToMember(
        ORG,
        'member-1',
        proposed.id,
        { userId: 'actor', permissions: managerPermissions },
      ),
    ).rejects.toThrow(NotFoundException);
  });
});

describe('RbacService owner-role creation policy', () => {
  function build() {
    const created = role('custom-owner', Array.from(ownerPermissions), ORG);
    const tx = {
      $executeRaw: vi.fn(),
      organizationMemberRole: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ ...created, _count: { members: 0 } }),
      },
    };
    const prisma = asPrisma({
      organizationMemberRole: { findUnique: vi.fn().mockResolvedValue(null) },
      permission: {
        findMany: vi.fn().mockResolvedValue(
          Array.from(ownerPermissions).map((key) => {
            const [resource, action] = key.split(':');
            return { id: `p-${key}`, resource, action };
          }),
        ),
      },
      $transaction: vi.fn((callback) => callback(tx)),
    });
    return new RbacService(prisma, catalog);
  }

  it('rejects the reserved permission on a partial custom role', async () => {
    await expect(
      build().createCustomRole(ORG, { name: 'Partial', slug: 'partial', permissions: [OWNER_KEY] }, ownerPermissions),
    ).rejects.toThrow(BadRequestException);
  });

  it('requires an owner-capable actor for a full owner role', async () => {
    await expect(
      build().createCustomRole(
        ORG,
        { name: 'Owner', slug: 'custom-owner', permissions: Array.from(ownerPermissions) },
        managerPermissions,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows an owner-capable actor to create a full owner role', async () => {
    await expect(
      build().createCustomRole(
        ORG,
        { name: 'Owner', slug: 'custom-owner', permissions: Array.from(ownerPermissions) },
        ownerPermissions,
      ),
    ).resolves.toMatchObject({ isOwnerCapable: true });
  });
});

describe('RbacService owner grants remain permission-subset bounded', () => {
  it('hides an owner-capable role carrying an out-of-catalog permission', () => {
    const service = new RbacService(asPrisma({}), catalog);
    const ownerWithAdminExtension = role('composed-owner', [...Array.from(ownerPermissions), 'admin.users:read']);
    expect(() => service.assertRoleAssignableBy(ownerWithAdminExtension, ownerPermissions, true)).toThrow(
      NotFoundException,
    );
  });
});

describe('RbacService dedicated owner flow', () => {
  function build(options?: {
    owners?: number;
    failSourceDemotion?: boolean;
    recipientOrg?: string;
    recipientDeleted?: boolean;
    recipientBanned?: boolean;
    sourceBanned?: boolean;
  }) {
    const roles = {
      owner: role('owner', Array.from(ownerPermissions)),
      reader: role('reader', ['member:read']),
    };
    const members = {
      source: member('source', 'source-user', roles.owner, ORG, null, options?.sourceBanned),
      recipient: member(
        'recipient',
        'recipient-user',
        roles.reader,
        options?.recipientOrg ?? ORG,
        options?.recipientDeleted ? new Date() : null,
        options?.recipientBanned,
      ),
    };
    const usableOwnerCount = options?.owners ?? 2;
    const ownerCandidates = options?.sourceBanned
      ? Array.from({ length: usableOwnerCount }, (_, index) =>
          member(`owner-${index + 2}`, `owner-${index + 2}-user`, roles.owner),
        )
      : [
          ...(usableOwnerCount > 0 ? [members.source] : []),
          ...Array.from({ length: Math.max(usableOwnerCount - 1, 0) }, (_, index) =>
            member(`owner-${index + 2}`, `owner-${index + 2}-user`, roles.owner),
          ),
        ];
    const updates: { id: string; roleId: string }[] = [];
    const tx = {
      $executeRaw: vi.fn(),
      member: {
        findUnique: vi.fn(({ where }) => Promise.resolve(members[where.id as keyof typeof members] ?? null)),
        findMany: vi.fn().mockResolvedValue(ownerCandidates),
        update: vi.fn(({ where, data }) => {
          updates.push({ id: where.id, roleId: data.assignedRoleId });
          if (options?.failSourceDemotion && where.id === 'source') {
            throw new Error('write failed');
          }
          const current = members[where.id as keyof typeof members];
          if (current) current.assignedRole = data.assignedRoleId === 'owner' ? roles.owner : roles.reader;
          return Promise.resolve(current);
        }),
      },
      organizationMemberRole: {
        findUnique: vi.fn(({ where }) => Promise.resolve(roles[where.id as keyof typeof roles] ?? null)),
      },
    };
    const prisma = asPrisma({ $transaction: vi.fn((callback) => callback(tx)) });
    return { service: new RbacService(prisma, catalog), updates, tx };
  }

  it('grants, revokes, and transfers with correctly shaped roles', async () => {
    const grant = build();
    await grant.service.grantOwnerAccess(ORG, 'recipient', 'owner', ownerPermissions);
    expect(grant.updates).toEqual([{ id: 'recipient', roleId: 'owner' }]);

    const revoke = build();
    await revoke.service.revokeOwnerAccess(ORG, 'source', 'reader', ownerPermissions);
    expect(revoke.updates).toEqual([{ id: 'source', roleId: 'reader' }]);

    const transfer = build({ owners: 1 });
    await transfer.service.transferOwnership(ORG, 'source', 'recipient', 'owner', 'reader', ownerPermissions);
    expect(transfer.updates).toEqual([
      { id: 'recipient', roleId: 'owner' },
      { id: 'source', roleId: 'reader' },
    ]);
  });

  it('rejects a partial actor and the last-owner revoke', async () => {
    await expect(build().service.grantOwnerAccess(ORG, 'recipient', 'owner', managerPermissions)).rejects.toThrow(
      ForbiddenException,
    );
    await expect(
      build({ owners: 1 }).service.revokeOwnerAccess(ORG, 'source', 'reader', ownerPermissions),
    ).rejects.toThrow(/last owner/);
  });

  it('only protects the usable-owner count when the target contributes to it', async () => {
    await expect(
      build({ owners: 1, sourceBanned: true }).service.revokeOwnerAccess(ORG, 'source', 'reader', ownerPermissions),
    ).resolves.toBeDefined();
    await expect(
      build({ owners: 0 }).service.revokeOwnerAccess(ORG, 'source', 'reader', ownerPermissions),
    ).rejects.toThrow(/last owner/);
  });

  it('prefilters usable owner candidates in the database before exact catalog verification', async () => {
    const { service, tx } = build({ owners: 1 });
    await expect(service.revokeOwnerAccess(ORG, 'source', 'reader', ownerPermissions)).rejects.toThrow(/last owner/);

    expect(tx.member.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG,
        deletedAt: null,
        user: {
          OR: [{ banned: false }, { banExpires: { lte: expect.any(Date) } }],
        },
        assignedRole: {
          rolePermissions: {
            some: {
              permission: {
                resource: 'organization',
                action: 'manage-owners',
              },
            },
          },
        },
      },
      include: expect.any(Object),
    });
  });

  it('does not count a DB-prefiltered partial owner role as owner-capable', async () => {
    const { service, tx } = build({ owners: 0 });
    tx.member.findMany.mockResolvedValue([
      member('partial-owner', 'partial-owner-user', role('partial-owner', [OWNER_KEY])),
    ]);

    await expect(service.revokeOwnerAccess(ORG, 'source', 'reader', ownerPermissions)).rejects.toThrow(/last owner/);
  });

  it('rejects wrong owner/non-owner role shapes', async () => {
    await expect(build().service.grantOwnerAccess(ORG, 'recipient', 'reader', ownerPermissions)).rejects.toThrow(
      /not owner-capable/,
    );
    await expect(build().service.revokeOwnerAccess(ORG, 'source', 'owner', ownerPermissions)).rejects.toThrow(
      /must not be owner-capable/,
    );
  });

  it('rejects cross-org, deleted, banned, and invalid grant targets', async () => {
    await expect(
      build({ recipientOrg: 'other-org' }).service.grantOwnerAccess(ORG, 'recipient', 'owner', ownerPermissions),
    ).rejects.toThrow(NotFoundException);
    await expect(
      build({ recipientDeleted: true }).service.grantOwnerAccess(ORG, 'recipient', 'owner', ownerPermissions),
    ).rejects.toThrow(NotFoundException);
    await expect(
      build({ recipientBanned: true }).service.grantOwnerAccess(ORG, 'recipient', 'owner', ownerPermissions),
    ).rejects.toThrow(ForbiddenException);
    await expect(build().service.grantOwnerAccess(ORG, 'recipient', 'missing-role', ownerPermissions)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('keeps transfer writes in one transaction and promotes first', async () => {
    const { service, updates } = build({ owners: 1, failSourceDemotion: true });
    await expect(
      service.transferOwnership(ORG, 'source', 'recipient', 'owner', 'reader', ownerPermissions),
    ).rejects.toThrow('write failed');
    expect(updates).toEqual([
      { id: 'recipient', roleId: 'owner' },
      { id: 'source', roleId: 'reader' },
    ]);
  });
});
