import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(
    here,
    '..',
    '..',
    'prisma',
    'migrations',
    '20260715220000_require_member_role_and_archive_roles',
    'migration.sql',
  ),
  'utf8',
);

const roleTable = '_member_cutover_roles';
const memberTable = '_member_cutover_members';

function replaceTableNames(statement: string): string {
  return statement.replace(/"OrganizationMemberRole"/g, `"${roleTable}"`).replace(/"Member"/g, `"${memberTable}"`);
}

function extractDoBlock(marker: string, label: string): string {
  const block = [...migrationSql.matchAll(/DO \$\$[\s\S]*?END \$\$;/g)]
    .map((match) => match[0])
    .find((statement) => statement.includes(marker));
  if (!block) throw new Error(`Could not locate ${label} in member role migration`);
  return replaceTableNames(block);
}

const seedGuard = extractDoBlock('exactly one active global system role', 'seeded-role guard');
const unresolvedGuard = extractDoBlock('assignedRoleId backfill incomplete', 'unresolved-role guard');
const backfillMatch = migrationSql.match(/UPDATE "Member" m[\s\S]*?\n {2}END;/);
if (!backfillMatch) throw new Error('Could not locate member backfill in member role migration');
const backfill = replaceTableNames(backfillMatch[0]);

describe.skipIf(!connectionString)('member role and archival migration', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    prisma = createPrismaClient({ connectionString });
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${memberTable}"`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${roleTable}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${roleTable}" (
        "id" TEXT PRIMARY KEY,
        "slug" TEXT NOT NULL,
        "isSystem" BOOLEAN NOT NULL,
        "organizationId" TEXT,
        "archivedAt" TIMESTAMP(3)
      )`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${memberTable}" (
        "id" TEXT PRIMARY KEY,
        "role" TEXT NOT NULL,
        "assignedRoleId" TEXT
      )`,
    );
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE "${memberTable}", "${roleTable}"`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${roleTable}" ("id", "slug", "isSystem", "organizationId")
       VALUES ('role-owner', 'owner', true, NULL),
              ('role-admin', 'admin', true, NULL),
              ('role-member', 'member', true, NULL)`,
    );
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${memberTable}"`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${roleTable}"`);
      await prisma.$disconnect();
    }
  });

  it('maps every legacy member role and preserves existing assignments', async () => {
    const cases: Array<[string, string, string]> = [
      ['owner', 'Owner', 'role-owner'],
      ['admin', 'Admin', 'role-admin'],
      ['super-admin', 'SuperAdmin', 'role-admin'],
      ['member', 'Member', 'role-member'],
    ];
    for (const [id, role] of cases) {
      await prisma.$executeRawUnsafe(`INSERT INTO "${memberTable}" ("id", "role") VALUES ($1, $2)`, id, role);
    }
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${roleTable}" ("id", "slug", "isSystem", "organizationId")
       VALUES ('role-custom', 'custom', false, 'org-1')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${memberTable}" ("id", "role", "assignedRoleId")
       VALUES ('custom', 'Member', 'role-custom')`,
    );

    await prisma.$executeRawUnsafe(seedGuard);
    await prisma.$executeRawUnsafe(backfill);
    await prisma.$executeRawUnsafe(unresolvedGuard);

    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; assignedRoleId: string }>>(
      `SELECT "id", "assignedRoleId" FROM "${memberTable}" ORDER BY "id"`,
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.assignedRoleId]))).toEqual({
      admin: 'role-admin',
      custom: 'role-custom',
      member: 'role-member',
      owner: 'role-owner',
      'super-admin': 'role-admin',
    });
  });

  it('aborts for missing, ambiguous, or archived system roles', async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "${roleTable}" WHERE "slug" = 'admin'`);
    await expect(prisma.$executeRawUnsafe(seedGuard)).rejects.toThrow(/admin \(found 0\)/);

    await prisma.$executeRawUnsafe(
      `INSERT INTO "${roleTable}" ("id", "slug", "isSystem", "organizationId")
       VALUES ('role-admin-a', 'admin', true, NULL), ('role-admin-b', 'admin', true, NULL)`,
    );
    await expect(prisma.$executeRawUnsafe(seedGuard)).rejects.toThrow(/admin \(found 2\)/);

    await prisma.$executeRawUnsafe(`DELETE FROM "${roleTable}" WHERE "id" = 'role-admin-b'`);
    await prisma.$executeRawUnsafe(`UPDATE "${roleTable}" SET "archivedAt" = now() WHERE "id" = 'role-admin-a'`);
    await expect(prisma.$executeRawUnsafe(seedGuard)).rejects.toThrow(/admin \(found 0\)/);
  });

  it('reports member rows that cannot be mapped', async () => {
    await prisma.$executeRawUnsafe(`INSERT INTO "${memberTable}" ("id", "role") VALUES ('unknown', 'Billing')`);
    await prisma.$executeRawUnsafe(backfill);
    await expect(prisma.$executeRawUnsafe(unresolvedGuard)).rejects.toThrow(/1 row\(s\).*Billing/);
  });

  it('enforces the production columns and restrictive foreign key', async () => {
    const columns = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; is_nullable: 'YES' | 'NO' }>
    >`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          (table_name = 'Member' AND column_name = 'assignedRoleId')
          OR (table_name = 'OrganizationMemberRole' AND column_name = 'archivedAt')
        )
      ORDER BY table_name, column_name
    `;
    expect(columns).toEqual([
      { table_name: 'Member', column_name: 'assignedRoleId', is_nullable: 'NO' },
      { table_name: 'OrganizationMemberRole', column_name: 'archivedAt', is_nullable: 'YES' },
    ]);

    const constraints = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
      SELECT confdeltype::text
      FROM pg_constraint
      WHERE conname = 'Member_assignedRoleId_fkey'
    `;
    expect(constraints).toEqual([{ confdeltype: 'r' }]);
  });
});
