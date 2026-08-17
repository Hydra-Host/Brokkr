/**
 * Must run after migrations. Safe to run against live traffic: permission and role writes are
 * upserts, and RolePermission rows are rewritten transactionally (upsert-then-prune), so a
 * role's permission set is never observably empty mid-seed.
 */

import { createPrismaClient, type PrismaClient } from '@repo/database';
import { getErrorMessage } from '../../common/error-utils';
import { MAIN_APP_PERMISSIONS, MAIN_APP_SYSTEM_ROLES } from '../../permissions/permissions.constants';
function permissionKey(resource: string, action: string): string {
  return `${resource}:${action}`;
}

export interface RoleSeedResult {
  name: string;
  slug: string;
  outcome: 'created' | 'updated';
  permissions: number;
  delta: number;
}

export interface SeedSummary {
  permissions: { created: number; updated: number; total: number };
  roles: RoleSeedResult[];
}

export async function seedPermissions(db: PrismaClient): Promise<SeedSummary> {
  const permissionIdMap = new Map<string, string>();

  const existing = await db.permission.findMany({ select: { resource: true, action: true } });
  const existingKeys = new Set(existing.map((p) => permissionKey(p.resource, p.action)));
  let created = 0;

  for (const perm of MAIN_APP_PERMISSIONS) {
    const key = permissionKey(perm.resource, perm.action);
    if (!existingKeys.has(key)) created++;
    const record = await db.permission.upsert({
      where: { resource_action: { resource: perm.resource, action: perm.action } },
      update: { description: perm.description },
      create: { resource: perm.resource, action: perm.action, description: perm.description },
    });
    permissionIdMap.set(key, record.id);
  }

  const roles: RoleSeedResult[] = [];

  // Custom org roles are user-owned and must not be touched — this seed would strip keys the catalog doesn't know about.
  for (const roleDef of MAIN_APP_SYSTEM_ROLES) {
    try {
      let role = await db.organizationMemberRole.findFirst({
        where: { slug: roleDef.slug, isSystem: true, organizationId: null },
      });
      const outcome: 'created' | 'updated' = role ? 'updated' : 'created';

      if (role) {
        role = await db.organizationMemberRole.update({
          where: { id: role.id },
          data: { name: roleDef.name, description: roleDef.description },
        });
      } else {
        role = await db.organizationMemberRole.create({
          data: {
            name: roleDef.name,
            slug: roleDef.slug,
            description: roleDef.description,
            isSystem: true,
            organizationId: null,
          },
        });
      }

      const permissionIds = roleDef.permissions
        .map((key) => permissionIdMap.get(key))
        .filter((id): id is string => id !== undefined);

      // Insert-then-prune inside a transaction so a hot role never has an empty permission set —
      // this runs at every boot while other instances (api replicas, admin-api) serve live traffic.
      // Two set-based statements (not per-row upserts) keep the interactive transaction well under
      // Prisma's default 5s timeout: skipDuplicates leans on @@unique([roleId, permissionId]) to
      // leave existing rows untouched, then the prune drops rows absent from the catalog.
      const roleId = role.id;
      const { created: rowsCreated, pruned: rowsPruned } = await db.$transaction(async (tx) => {
        const { count: createdCount } = await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
          skipDuplicates: true,
        });
        const { count: prunedCount } = await tx.rolePermission.deleteMany({
          where: { roleId, permissionId: { notIn: permissionIds } },
        });
        return { created: createdCount, pruned: prunedCount };
      });

      roles.push({
        name: roleDef.name,
        slug: roleDef.slug,
        outcome,
        permissions: permissionIds.length,
        delta: rowsCreated - rowsPruned,
      });
    } catch (error) {
      throw new Error(`Failed seeding system role "${roleDef.slug}": ${getErrorMessage(error)}`, { cause: error });
    }
  }

  return { permissions: { created, updated: permissionIdMap.size - created, total: permissionIdMap.size }, roles };
}

export function printSeedSummary(summary: SeedSummary): void {
  const { created, updated, total } = summary.permissions;
  console.info(`  Permissions: ${created} created, ${updated} updated (${total} total)`);
  console.info('  System roles:');
  for (const role of summary.roles) {
    const drift = role.delta === 0 ? 'no change' : `${role.delta > 0 ? '+' : ''}${role.delta}`;
    console.info(`    ${role.name.padEnd(8)} ${role.outcome}  ${role.permissions} permissions (${drift})`);
  }
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL environment variable is required. Source apps/api/env.sh first.');
  }
  const prisma = createPrismaClient({ connectionString });

  console.info('═══════════════════════════════════════════════════════');
  console.info('  Permissions & System Roles Seed');
  console.info(`  Started at: ${new Date().toISOString()}`);
  console.info('═══════════════════════════════════════════════════════\n');

  const startedAt = Date.now();
  try {
    const summary = await seedPermissions(prisma);
    printSeedSummary(summary);
    console.info(`\n  ✓ SUCCESS in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } finally {
    await prisma.$disconnect();
  }
}

const isSeedScript = process.argv.includes('--seed-script');
if (isSeedScript) {
  main().catch((error) => {
    console.error(`\n  ✗ FAILED: ${getErrorMessage(error)}`);
    process.exit(1);
  });
}
