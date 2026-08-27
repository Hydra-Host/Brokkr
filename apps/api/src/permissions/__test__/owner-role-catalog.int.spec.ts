import { isOwnerCapable, MAIN_APP_PERMISSIONS } from '@repo/auth/rbac';
import { createPrismaClient, type PrismaClient } from '@repo/database';
import { seedPermissions } from 'src/scripts/rbac/permissions';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const connectionString = process.env.DATABASE_URL;

function permissionKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

const catalogKeys = MAIN_APP_PERMISSIONS.map((permission) => permissionKey(permission.resource, permission.action));

function catalogKeysPersistedButUnheld(persisted: Set<string>, held: Set<string>): string[] {
  return catalogKeys.filter((key) => persisted.has(key) && !held.has(key));
}

describe.skipIf(!connectionString)('owner system role capability (integration, live DB)', () => {
  let prisma: PrismaClient;
  let ownerPermissions: string[];
  let persistedKeys: Set<string>;

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: connectionString! });
    await seedPermissions(prisma);

    const rows = await prisma.rolePermission.findMany({
      where: { role: { slug: 'owner', isSystem: true, organizationId: null, archivedAt: null } },
      select: { permission: { select: { resource: true, action: true } } },
    });
    ownerPermissions = rows.map((row) => permissionKey(row.permission.resource, row.permission.action));

    const persisted = await prisma.permission.findMany({ select: { resource: true, action: true } });
    persistedKeys = new Set(persisted.map((row) => permissionKey(row.resource, row.action)));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('persists the whole catalog, so the capability assertions cannot pass on a near-empty table', () => {
    const unpersisted = catalogKeys.filter((key) => !persistedKeys.has(key));

    expect(unpersisted).toEqual([]);
    expect(catalogKeys.length).toBeGreaterThan(0);
  });

  it('holds every catalog permission the database persists', () => {
    const held = new Set(ownerPermissions);

    expect(catalogKeysPersistedButUnheld(persistedKeys, held)).toEqual([]);
  });

  it('is owner-capable across the persisted catalog', () => {
    const persistedCatalog = MAIN_APP_PERMISSIONS.filter((permission) =>
      persistedKeys.has(permissionKey(permission.resource, permission.action)),
    );

    expect(persistedCatalog.length).toBeGreaterThan(0);
    expect(isOwnerCapable(persistedCatalog, ownerPermissions)).toBe(true);
  });

  it('flags a single withheld permission, so a clean result is a real one', () => {
    const withheld = new Set(ownerPermissions);
    const dropped = catalogKeys.find((key) => withheld.has(key))!;
    withheld.delete(dropped);

    expect(catalogKeysPersistedButUnheld(persistedKeys, withheld)).toEqual([dropped]);
    expect(isOwnerCapable(MAIN_APP_PERMISSIONS, withheld)).toBe(false);
  });
});
