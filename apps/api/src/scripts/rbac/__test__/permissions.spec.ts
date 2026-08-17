import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@repo/database', () => ({ createPrismaClient: vi.fn() }));
vi.mock('../../../permissions/permissions.constants', () => ({
  MAIN_APP_PERMISSIONS: [
    { resource: 'zone', action: 'read', description: 'Read zones' },
    { resource: 'zone', action: 'create', description: 'Create zones' },
  ],
  MAIN_APP_SYSTEM_ROLES: [
    { slug: 'owner', name: 'Owner', description: 'Full control', permissions: ['zone:read', 'zone:create'] },
  ],
}));

import { seedPermissions } from '../permissions';

const permIds: Record<string, string> = {
  'zone:read': 'perm-zone-read',
  'zone:create': 'perm-zone-create',
};

function makeDb(options?: {
  existingRole?: boolean;
  createdCount?: number;
  prunedCount?: number;
  createManyError?: Error;
}) {
  const existingRole = options?.existingRole ?? true;
  const operationLog: string[] = [];

  const tx = {
    rolePermission: {
      createMany: vi.fn(async () => {
        operationLog.push('tx.createMany');
        if (options?.createManyError) throw options.createManyError;
        return { count: options?.createdCount ?? 0 };
      }),
      deleteMany: vi.fn(async () => {
        operationLog.push('tx.deleteMany');
        return { count: options?.prunedCount ?? 0 };
      }),
    },
  };

  const db = {
    permission: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(async ({ create }: { create: { resource: string; action: string } }) => ({
        id: permIds[`${create.resource}:${create.action}`],
      })),
    },
    organizationMemberRole: {
      findFirst: vi.fn().mockResolvedValue(existingRole ? { id: 'role-owner' } : null),
      update: vi.fn(async () => ({ id: 'role-owner' })),
      create: vi.fn(async () => ({ id: 'role-owner' })),
    },
    rolePermission: {
      count: vi.fn(),
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      create: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      operationLog.push('$transaction:start');
      const result = await fn(tx);
      operationLog.push('$transaction:end');
      return result;
    }),
  };

  return { db: db as never, raw: db, tx, operationLog };
}

describe('seedPermissions', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rewrites role permissions transactionally with one bulk insert before the prune', async () => {
    const { db, raw, tx, operationLog } = makeDb();

    await seedPermissions(db);

    expect(raw.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.rolePermission.createMany).toHaveBeenCalledExactlyOnceWith({
      data: [
        { roleId: 'role-owner', permissionId: 'perm-zone-read' },
        { roleId: 'role-owner', permissionId: 'perm-zone-create' },
      ],
      skipDuplicates: true,
    });
    expect(tx.rolePermission.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: { roleId: 'role-owner', permissionId: { notIn: ['perm-zone-read', 'perm-zone-create'] } },
    });
    expect(operationLog).toEqual(['$transaction:start', 'tx.createMany', 'tx.deleteMany', '$transaction:end']);
  });

  it('never touches rolePermission outside the transaction', async () => {
    const { db, raw } = makeDb();

    await seedPermissions(db);

    expect(raw.rolePermission.count).not.toHaveBeenCalled();
    expect(raw.rolePermission.createMany).not.toHaveBeenCalled();
    expect(raw.rolePermission.deleteMany).not.toHaveBeenCalled();
    expect(raw.rolePermission.create).not.toHaveBeenCalled();
  });

  it('reports the permission delta as rows created minus rows pruned', async () => {
    const { db } = makeDb({ createdCount: 2, prunedCount: 1 });

    const summary = await seedPermissions(db);

    expect(summary.roles).toEqual([{ name: 'Owner', slug: 'owner', outcome: 'updated', permissions: 2, delta: 1 }]);
  });

  it('creates a missing system role before seeding its permissions', async () => {
    const { db, raw } = makeDb({ existingRole: false });

    const summary = await seedPermissions(db);

    expect(raw.organizationMemberRole.create).toHaveBeenCalledWith({
      data: {
        name: 'Owner',
        slug: 'owner',
        description: 'Full control',
        isSystem: true,
        organizationId: null,
      },
    });
    expect(summary.roles[0]?.outcome).toBe('created');
  });

  it('wraps role seeding failures with the role slug', async () => {
    const { db } = makeDb({ createManyError: new Error('deadlock detected') });

    await expect(seedPermissions(db)).rejects.toThrow('Failed seeding system role "owner": deadlock detected');
  });
});
