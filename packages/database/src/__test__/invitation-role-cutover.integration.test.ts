import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;
const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(here, '..', '..', 'prisma', 'migrations', '20260714210000_add_invitation_assigned_role', 'migration.sql'),
  'utf8',
);

const roleTable = '_invitation_cutover_roles';
const invitationTable = '_invitation_cutover_invitations';

function extractStatement(pattern: RegExp, label: string): string {
  const match = migrationSql.match(pattern);
  if (!match) throw new Error(`Could not locate ${label} in invitation role migration`);
  return match[0]
    .replace(/"OrganizationMemberRole"/g, `"${roleTable}"`)
    .replace(/"Invitation"/g, `"${invitationTable}"`);
}

function extractDoBlock(marker: string, label: string): string {
  const block = [...migrationSql.matchAll(/DO \$\$[\s\S]*?END \$\$;/g)]
    .map((match) => match[0])
    .find((statement) => statement.includes(marker));
  if (!block) throw new Error(`Could not locate ${label} in invitation role migration`);
  return block.replace(/"OrganizationMemberRole"/g, `"${roleTable}"`).replace(/"Invitation"/g, `"${invitationTable}"`);
}

const seedGuard = extractDoBlock('missing seeded system role(s)', 'seeded-role guard');
const backfill = extractStatement(/UPDATE "Invitation" i[\s\S]*?END;/, 'invitation backfill');
const unresolvedGuard = extractDoBlock('assignedRoleId backfill incomplete', 'unresolved-role guard');

describe.skipIf(!connectionString)('invitation assigned-role migration', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    if (!connectionString) throw new Error('DATABASE_URL is required');
    prisma = createPrismaClient({ connectionString });
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${invitationTable}"`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${roleTable}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${roleTable}" (
        "id" TEXT PRIMARY KEY,
        "slug" TEXT NOT NULL,
        "isSystem" BOOLEAN NOT NULL,
        "organizationId" TEXT
      )`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${invitationTable}" (
        "id" TEXT PRIMARY KEY,
        "role" TEXT NOT NULL,
        "assignedRoleId" TEXT
      )`,
    );
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE "${invitationTable}", "${roleTable}"`);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${roleTable}" ("id", "slug", "isSystem", "organizationId")
       VALUES ('role-owner', 'owner', true, NULL),
              ('role-admin', 'admin', true, NULL),
              ('role-member', 'member', true, NULL)`,
    );
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${invitationTable}"`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${roleTable}"`);
      await prisma.$disconnect();
    }
  });

  it('maps every supported legacy spelling to its seeded role', async () => {
    const cases: Array<[string, string, string]> = [
      ['owner-title', 'Owner', 'role-owner'],
      ['owner-lower', 'owner', 'role-owner'],
      ['admin-title', 'Admin', 'role-admin'],
      ['admin-lower', 'admin', 'role-admin'],
      ['super-title', 'SuperAdmin', 'role-admin'],
      ['super-lower', 'superAdmin', 'role-admin'],
      ['member-title', 'Member', 'role-member'],
      ['member-lower', 'member', 'role-member'],
    ];
    for (const [id, role] of cases) {
      await prisma.$executeRawUnsafe(`INSERT INTO "${invitationTable}" ("id", "role") VALUES ($1, $2)`, id, role);
    }

    await prisma.$executeRawUnsafe(seedGuard);
    await prisma.$executeRawUnsafe(backfill);
    await prisma.$executeRawUnsafe(unresolvedGuard);

    const rows = await prisma.$queryRawUnsafe<Array<{ id: string; assignedRoleId: string }>>(
      `SELECT "id", "assignedRoleId" FROM "${invitationTable}" ORDER BY "id"`,
    );
    expect(Object.fromEntries(rows.map((row) => [row.id, row.assignedRoleId]))).toEqual(
      Object.fromEntries(cases.map(([id, , roleId]) => [id, roleId])),
    );
  });

  it('preserves role IDs written before a repaired migration replay', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${roleTable}" ("id", "slug", "isSystem", "organizationId")
       VALUES ('role-custom', 'local-admin', false, 'org-1')`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${invitationTable}" ("id", "role", "assignedRoleId")
       VALUES ('partial-cutover', 'member', 'role-custom')`,
    );

    await prisma.$executeRawUnsafe(backfill);

    const rows = await prisma.$queryRawUnsafe<Array<{ assignedRoleId: string }>>(
      `SELECT "assignedRoleId" FROM "${invitationTable}" WHERE "id" = 'partial-cutover'`,
    );
    expect(rows).toEqual([{ assignedRoleId: 'role-custom' }]);
  });

  it('aborts and reports unresolved invitation roles', async () => {
    await prisma.$executeRawUnsafe(`INSERT INTO "${invitationTable}" ("id", "role") VALUES ('unknown', 'Billing')`);
    await prisma.$executeRawUnsafe(backfill);
    await expect(prisma.$executeRawUnsafe(unresolvedGuard)).rejects.toThrow(/1 row\(s\).*Billing/);
  });

  it('aborts when a required seeded system role is absent', async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "${roleTable}" WHERE "slug" = 'admin'`);
    await expect(prisma.$executeRawUnsafe(seedGuard)).rejects.toThrow(/missing seeded system role\(s\): admin/);
  });

  it('enforces the final columns and restrictive foreign key', async () => {
    const columns = await prisma.$queryRaw<
      Array<{ table_name: string; column_name: string; is_nullable: 'YES' | 'NO' }>
    >`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name IN ('Invitation', 'OrganizationMembershipInvitation')
        AND column_name IN ('role', 'assignedRoleId')
      ORDER BY table_name, column_name
    `;
    expect(columns).toEqual([{ table_name: 'Invitation', column_name: 'assignedRoleId', is_nullable: 'NO' }]);

    const constraints = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
      SELECT confdeltype::text
      FROM pg_constraint
      WHERE conname = 'Invitation_assignedRoleId_fkey'
    `;
    expect(constraints).toEqual([{ confdeltype: 'r' }]);
  });
});
