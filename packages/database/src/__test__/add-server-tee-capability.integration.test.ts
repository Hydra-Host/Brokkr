import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  join(here, '..', '..', 'prisma', 'migrations', '20260628130000_add_server_tee_capability', 'migration.sql'),
  'utf8',
);

function backfillStatementFor(serverTable: string): string {
  const match = MIGRATION_SQL.match(/UPDATE\s+"Server"[\s\S]*?;/);
  if (!match) throw new Error('Could not locate the backfill UPDATE in migration.sql');
  return match[0].replace(/"Server"/g, `"${serverTable}"`);
}

describe.skipIf(!connectionString)('add_server_tee_capability migration', () => {
  let prisma: PrismaClient;
  const TABLE = '_bf_server_tee';

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: connectionString! });
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${TABLE}" ("id" TEXT PRIMARY KEY, "teeEnabled" BOOLEAN NOT NULL DEFAULT false, "teeCapable" "TeeCapability" NOT NULL DEFAULT 'UNVERIFIED')`,
    );
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${TABLE}"`);
      await prisma.$disconnect();
    }
  });

  it('backfills teeCapable=PATCH only for servers with teeEnabled=true', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${TABLE}" ("id", "teeEnabled", "teeCapable") VALUES ` +
        `('enabled', true, 'UNVERIFIED'), ('disabled', false, 'UNVERIFIED'), ('also-disabled', false, 'UNVERIFIED')`,
    );

    await prisma.$executeRawUnsafe(backfillStatementFor(TABLE));

    const rows = await prisma.$queryRawUnsafe<{ id: string; teeCapable: string }[]>(
      `SELECT "id", "teeCapable"::text FROM "${TABLE}" ORDER BY "id"`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.teeCapable]));

    expect(byId.enabled).toBe('PATCH');
    expect(byId.disabled).toBe('UNVERIFIED');
    expect(byId['also-disabled']).toBe('UNVERIFIED');
  });

  it('migration DDL matches live schema: column default and enum values', async () => {
    const colDefault = await prisma.$queryRawUnsafe<{ column_default: string }[]>(
      `SELECT column_default FROM information_schema.columns WHERE table_name='Server' AND column_name='teeCapable'`,
    );
    expect(colDefault[0]?.column_default).toBe('\'UNVERIFIED\'::"TeeCapability"');

    const enumValues = await prisma.$queryRawUnsafe<{ enumlabel: string }[]>(
      `SELECT e.enumlabel FROM pg_type t JOIN pg_enum e ON t.oid = e.enumtypid WHERE t.typname = 'TeeCapability' ORDER BY e.enumsortorder`,
    );
    expect(enumValues.map((r) => r.enumlabel)).toEqual(['UNVERIFIED', 'FALSE', 'PATCH', 'TRUE']);
  });
});
