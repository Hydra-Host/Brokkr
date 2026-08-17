import type { PrismaClient } from '@repo/database';
import { describe, expect, it, vi } from 'vitest';
import { RbacService } from '../rbac/rbac.service';
import type { RbacConfig } from '../rbac/types';

const ORG = 'org-1';
const asPrisma = (mock: object) => mock as unknown as PrismaClient;

const catalog: RbacConfig = {
  permissions: [
    { resource: 'device', action: 'read', description: '', audit: 'read-only' },
    { resource: 'device', action: 'write', description: '', audit: 'mutating' },
  ],
  systemRoles: [],
};

const FULL_CATALOG = new Set(['device:read', 'device:write']);

const grantsFor = (keys: string[]) =>
  keys.map((key) => {
    const [resource, action] = key.split(':');
    return { permissionId: `p-${action}`, permission: { resource, action } };
  });

function roleFixture(id: string, keys: string[], overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `role-${id}`,
    slug: `slug-${id}`,
    archivedAt: null,
    isSystem: false,
    organizationId: ORG,
    rolePermissions: grantsFor(keys),
    _count: { members: 0, invitations: 0 },
    ...overrides,
  };
}

function buildHarness(options: { existingSlug?: object | null } = {}) {
  const ownerRole = roleFixture('r-owner', ['device:read', 'device:write']);
  const plainRole = roleFixture('r-plain', ['device:read']);
  const member = {
    id: 'm-1',
    userId: 'u-1',
    organizationId: ORG,
    deletedAt: null,
    assignedRole: plainRole,
    assignedRoleId: 'r-plain',
    user: { banned: false, banExpires: null },
  };

  const byId = (args: { where?: { id?: string; slug_organizationId?: unknown } }) => {
    if (args.where?.slug_organizationId !== undefined) return options.existingSlug ?? null;
    return args.where?.id === 'r-owner' ? ownerRole : plainRole;
  };

  const tx = {
    $executeRaw: vi.fn(),
    organizationMemberRole: {
      findUnique: vi.fn(byId),
      findMany: vi.fn().mockResolvedValue([ownerRole, plainRole]),
      update: vi.fn().mockResolvedValue(plainRole),
      create: vi.fn().mockResolvedValue(plainRole),
      count: vi.fn().mockResolvedValue(0),
    },
    member: {
      findUnique: vi.fn().mockResolvedValue(member),
      findMany: vi.fn().mockResolvedValue([member, { ...member, id: 'm-2' }]),
      update: vi.fn().mockResolvedValue(member),
      count: vi.fn().mockResolvedValue(2),
    },
    rolePermission: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };

  const $transaction = vi.fn(async (cb: (client: unknown) => Promise<unknown>) => cb(tx));
  const prisma = asPrisma({
    organizationMemberRole: {
      findUnique: vi.fn(byId),
      findMany: vi.fn().mockResolvedValue([ownerRole, plainRole]),
      count: vi.fn().mockResolvedValue(0),
    },
    permission: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'p-read', resource: 'device', action: 'read' },
        { id: 'p-write', resource: 'device', action: 'write' },
      ]),
    },
    $transaction,
  });

  return { service: new RbacService(prisma, catalog), tx };
}

describe('RbacService transaction-local emit', () => {
  it('invokes emit with the client the bare-transaction mutation used', async () => {
    const { service, tx } = buildHarness();
    const emit = vi.fn().mockResolvedValue(undefined);

    await service.updateRolePermissions('r-plain', ['device:read'], ORG, FULL_CATALOG, emit);

    expect(emit).toHaveBeenCalledWith(tx);
  });

  it('invokes emit with the client the owner-lock mutation used', async () => {
    const { service, tx } = buildHarness();
    const emit = vi.fn().mockResolvedValue(undefined);

    await service.archiveCustomRole('r-plain', ORG, FULL_CATALOG, emit);

    expect(emit).toHaveBeenCalledWith(tx);
  });

  it('invokes emit with the client the capacity-lock create used', async () => {
    const { service, tx } = buildHarness({ existingSlug: null });
    const emit = vi.fn().mockResolvedValue(undefined);

    await service.createCustomRole(ORG, { name: 'New', slug: 'new', permissions: ['device:read'] }, FULL_CATALOG, emit);

    expect(emit).toHaveBeenCalledWith(tx);
  });

  it('grants owner access with the same client', async () => {
    const { service, tx } = buildHarness();
    const emit = vi.fn().mockResolvedValue(undefined);

    await service.grantOwnerAccess(ORG, 'm-1', 'r-owner', FULL_CATALOG, emit);

    expect(emit).toHaveBeenCalledWith(tx);
  });

  it('propagates a failing emit so the enclosing transaction rolls back', async () => {
    const { service } = buildHarness();
    const emit = vi.fn().mockRejectedValue(new Error('event write failed'));

    await expect(service.archiveCustomRole('r-plain', ORG, FULL_CATALOG, emit)).rejects.toThrow('event write failed');
  });

  it('runs emit after the mutation, not before', async () => {
    const { service, tx } = buildHarness();
    const order: string[] = [];
    tx.organizationMemberRole.update.mockImplementation(async () => {
      order.push('mutation');
      return roleFixture('r-plain', ['device:read'], { archivedAt: new Date() });
    });
    const emit = vi.fn().mockImplementation(async () => {
      order.push('emit');
    });

    await service.archiveCustomRole('r-plain', ORG, FULL_CATALOG, emit);

    expect(order).toEqual(['mutation', 'emit']);
  });

  it('stays optional so existing callers are unaffected', async () => {
    const { service } = buildHarness();

    await expect(service.archiveCustomRole('r-plain', ORG, FULL_CATALOG)).resolves.toBeDefined();
  });
});
