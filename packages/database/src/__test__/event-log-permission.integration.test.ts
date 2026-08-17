import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

const EVENT_LOG_ACCESS = { resource: 'event-log', action: 'access' };
const OWNER_MANAGEMENT = { resource: 'organization', action: 'manage-owners' };

describe.skipIf(!connectionString)('event-log:access grant', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: connectionString! });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function systemRoleHolds(slug: string, permission: { resource: string; action: string }): Promise<boolean> {
    const match = await prisma.rolePermission.findFirst({
      where: {
        role: { slug, isSystem: true, organizationId: null, archivedAt: null },
        permission,
      },
      select: { id: true },
    });
    return match !== null;
  }

  it('grants event-log:access to the owner system role', async () => {
    expect(await systemRoleHolds('owner', EVENT_LOG_ACCESS)).toBe(true);
  });

  it('grants event-log:access to the admin system role', async () => {
    expect(await systemRoleHolds('admin', EVENT_LOG_ACCESS)).toBe(true);
  });

  it('withholds event-log:access from the member system role', async () => {
    expect(await systemRoleHolds('member', EVENT_LOG_ACCESS)).toBe(false);
  });

  it('backfills every custom owner-capable role', async () => {
    const ownerCapableRoles = await prisma.organizationMemberRole.findMany({
      where: {
        organizationId: { not: null },
        isSystem: false,
        archivedAt: null,
        rolePermissions: { some: { permission: OWNER_MANAGEMENT } },
      },
      select: {
        slug: true,
        organizationId: true,
        rolePermissions: { where: { permission: EVENT_LOG_ACCESS }, select: { id: true } },
      },
    });

    const missing = ownerCapableRoles
      .filter((role) => role.rolePermissions.length === 0)
      .map((role) => `${role.organizationId}/${role.slug}`);

    expect(missing).toEqual([]);
  });
});
