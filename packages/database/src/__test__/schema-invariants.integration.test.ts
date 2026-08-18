import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

describe.skipIf(!connectionString)('schema invariants', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: connectionString! });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('keeps assignedRoleId as the only invitation role column, non-null', async () => {
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
  });

  it('restricts deleting a role that invitations reference', async () => {
    const constraints = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
      SELECT confdeltype::text
      FROM pg_constraint
      WHERE conname = 'Invitation_assignedRoleId_fkey'
    `;
    expect(constraints).toEqual([{ confdeltype: 'r' }]);
  });

  it('keeps member role assignment required and role archival nullable', async () => {
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
  });

  it('restricts deleting a role that members reference', async () => {
    const constraints = await prisma.$queryRaw<Array<{ confdeltype: string }>>`
      SELECT confdeltype::text
      FROM pg_constraint
      WHERE conname = 'Member_assignedRoleId_fkey'
    `;
    expect(constraints).toEqual([{ confdeltype: 'r' }]);
  });

  it('keeps the TeeCapability enum order and the teeCapable default', async () => {
    const colDefault = await prisma.$queryRaw<Array<{ column_default: string }>>`
      SELECT column_default FROM information_schema.columns
      WHERE table_name = 'Server' AND column_name = 'teeCapable'
    `;
    expect(colDefault[0]?.column_default).toBe('\'UNVERIFIED\'::"TeeCapability"');

    const enumValues = await prisma.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid
      WHERE t.typname = 'TeeCapability' ORDER BY e.enumsortorder
    `;
    expect(enumValues.map((r) => r.enumlabel)).toEqual(['UNVERIFIED', 'FALSE', 'PATCH', 'TRUE']);
  });
});
