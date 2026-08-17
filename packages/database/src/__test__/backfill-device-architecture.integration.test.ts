import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  join(here, '..', '..', 'prisma', 'migrations', '20260512010000_backfill_device_architecture', 'migration.sql'),
  'utf8',
);

function backfillStatementFor(deviceTable: string, metadataTable: string): string {
  const match = MIGRATION_SQL.match(/UPDATE\s+"Device"[\s\S]*?;/);
  if (!match) throw new Error('Could not locate the backfill UPDATE in migration.sql');
  return match[0].replace(/"Device"/g, `"${deviceTable}"`).replace(/"DeviceMetadata"/g, `"${metadataTable}"`);
}

describe.skipIf(!connectionString)('backfill_device_architecture migration', () => {
  let prisma: PrismaClient;
  const DEVICE = '_bf_device';
  const META = '_bf_device_metadata';

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: connectionString! });
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${DEVICE}"`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${META}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${DEVICE}" ("id" TEXT PRIMARY KEY, "netboxId" INTEGER, "architecture" TEXT)`,
    );
    await prisma.$executeRawUnsafe(`CREATE TABLE "${META}" ("id" INTEGER PRIMARY KEY, "arch" TEXT)`);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${DEVICE}"`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${META}"`);
      await prisma.$disconnect();
    }
  });

  it('backfills architecture only onto NetBox-matched rows, leaving others untouched', async () => {
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${META}" ("id", "arch") VALUES (101, 'amd64'), (102, 'arm64'), (104, NULL)`,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${DEVICE}" ("id", "netboxId", "architecture") VALUES ` +
        `('matched', 101, NULL), ('discovered', 102, 'x86_64'), ('orphan', 999, NULL), ('no-arch', 104, NULL)`,
    );

    await prisma.$executeRawUnsafe(backfillStatementFor(DEVICE, META));

    const rows = await prisma.$queryRawUnsafe<{ id: string; architecture: string | null }[]>(
      `SELECT "id", "architecture" FROM "${DEVICE}" ORDER BY "id"`,
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.architecture]));

    expect(byId.matched).toBe('amd64');
    expect(byId.discovered).toBe('x86_64');
    expect(byId.orphan).toBeNull();
    expect(byId['no-arch']).toBeNull();
  });
});
