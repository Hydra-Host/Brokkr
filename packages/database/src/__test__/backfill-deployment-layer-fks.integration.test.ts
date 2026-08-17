import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  join(here, '..', '..', 'prisma', 'migrations', '20260626000100_add_deployment_layer_fks', 'migration.sql'),
  'utf8',
);

describe.skipIf(!connectionString)('backfill_deployment_layer_fks migration', () => {
  let prisma: PrismaClient;
  const DEPLOYMENT = '_bf_deployment';
  const OS = '_bf_operating_system';
  const LAYER = '_bf_layer';

  function backfillStatement(column: 'baseLayerId' | 'rescueLayerId'): string {
    const match = MIGRATION_SQL.match(new RegExp(`UPDATE\\s+"Deployment"\\s+d\\s+SET\\s+"${column}"[\\s\\S]*?;`));
    if (!match) throw new Error(`Could not locate the ${column} backfill UPDATE in migration.sql`);
    return match[0]
      .replace(/"Deployment"/g, `"${DEPLOYMENT}"`)
      .replace(/"OperatingSystem"/g, `"${OS}"`)
      .replace(/"Layer"/g, `"${LAYER}"`);
  }

  const insertLayer = (id: string, slug: string) =>
    prisma.$executeRawUnsafe(`INSERT INTO "${LAYER}" ("id", "slug") VALUES ($1, $2)`, id, slug);
  const insertOs = (id: string, slug: string) =>
    prisma.$executeRawUnsafe(`INSERT INTO "${OS}" ("id", "slug") VALUES ($1, $2)`, id, slug);
  const insertDeployment = (id: string, osId: string | null, rescueOsId: string | null) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "${DEPLOYMENT}" ("id", "operatingSystemId", "currentRescueOperatingSystemId", "baseLayerId", "rescueLayerId")
        VALUES ($1, $2, $3, NULL, NULL)`,
      id,
      osId,
      rescueOsId,
    );

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: connectionString! });
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${DEPLOYMENT}"`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${OS}"`);
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${LAYER}"`);
    await prisma.$executeRawUnsafe(`CREATE TABLE "${LAYER}" ("id" TEXT PRIMARY KEY, "slug" TEXT NOT NULL UNIQUE)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE "${OS}" ("id" TEXT PRIMARY KEY, "slug" TEXT NOT NULL)`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${DEPLOYMENT}" (
        "id" TEXT PRIMARY KEY,
        "operatingSystemId" TEXT,
        "currentRescueOperatingSystemId" TEXT,
        "baseLayerId" TEXT,
        "rescueLayerId" TEXT
      )`,
    );
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE "${DEPLOYMENT}", "${OS}", "${LAYER}"`);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${DEPLOYMENT}"`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${OS}"`);
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${LAYER}"`);
      await prisma.$disconnect();
    }
  });

  it('backfills baseLayerId for deployments whose OS slug matches a Layer', async () => {
    await insertLayer('layer-ubuntu', 'ubuntu-noble');
    await insertOs('os-ubuntu', 'ubuntu-noble');
    await insertDeployment('dep-matched', 'os-ubuntu', null);

    await prisma.$executeRawUnsafe(backfillStatement('baseLayerId'));

    const rows = await prisma.$queryRawUnsafe<{ id: string; baseLayerId: string | null }[]>(
      `SELECT "id", "baseLayerId" FROM "${DEPLOYMENT}" WHERE "id" = 'dep-matched'`,
    );
    expect(rows[0]?.baseLayerId).toBe('layer-ubuntu');
  });

  it('leaves baseLayerId NULL when OS slug has no matching Layer', async () => {
    await insertOs('os-legacy', 'centos-7');
    await insertDeployment('dep-unmatched', 'os-legacy', null);

    await prisma.$executeRawUnsafe(backfillStatement('baseLayerId'));

    const rows = await prisma.$queryRawUnsafe<{ id: string; baseLayerId: string | null }[]>(
      `SELECT "id", "baseLayerId" FROM "${DEPLOYMENT}" WHERE "id" = 'dep-unmatched'`,
    );
    expect(rows[0]?.baseLayerId).toBeNull();
  });

  it('backfills rescueLayerId independently from baseLayerId', async () => {
    await insertLayer('layer-ubuntu', 'ubuntu-noble');
    await insertLayer('layer-rescue', 'ubuntu-rescue-os');
    await insertOs('os-ubuntu', 'ubuntu-noble');
    await insertOs('os-rescue', 'ubuntu-rescue-os');
    await insertDeployment('dep-rescue', 'os-ubuntu', 'os-rescue');

    await prisma.$executeRawUnsafe(backfillStatement('baseLayerId'));
    await prisma.$executeRawUnsafe(backfillStatement('rescueLayerId'));

    const rows = await prisma.$queryRawUnsafe<
      { id: string; baseLayerId: string | null; rescueLayerId: string | null }[]
    >(`SELECT "id", "baseLayerId", "rescueLayerId" FROM "${DEPLOYMENT}" WHERE "id" = 'dep-rescue'`);
    expect(rows[0]?.baseLayerId).toBe('layer-ubuntu');
    expect(rows[0]?.rescueLayerId).toBe('layer-rescue');
  });

  it('leaves rescueLayerId NULL when currentRescueOperatingSystemId is NULL', async () => {
    await insertDeployment('dep-no-rescue', null, null);

    await prisma.$executeRawUnsafe(backfillStatement('rescueLayerId'));

    const rows = await prisma.$queryRawUnsafe<{ id: string; rescueLayerId: string | null }[]>(
      `SELECT "id", "rescueLayerId" FROM "${DEPLOYMENT}" WHERE "id" = 'dep-no-rescue'`,
    );
    expect(rows[0]?.rescueLayerId).toBeNull();
  });

  it('re-running the backfill converges to the same value (idempotent)', async () => {
    await insertLayer('layer-ubuntu', 'ubuntu-noble');
    await insertOs('os-ubuntu', 'ubuntu-noble');
    await insertDeployment('dep-rerun', 'os-ubuntu', null);

    await prisma.$executeRawUnsafe(backfillStatement('baseLayerId'));
    const after1 = await prisma.$queryRawUnsafe<{ baseLayerId: string | null }[]>(
      `SELECT "baseLayerId" FROM "${DEPLOYMENT}" WHERE "id" = 'dep-rerun'`,
    );
    expect(after1[0]?.baseLayerId).toBe('layer-ubuntu');

    await prisma.$executeRawUnsafe(backfillStatement('baseLayerId'));
    const after2 = await prisma.$queryRawUnsafe<{ baseLayerId: string | null }[]>(
      `SELECT "baseLayerId" FROM "${DEPLOYMENT}" WHERE "id" = 'dep-rerun'`,
    );
    expect(after2[0]?.baseLayerId).toBe('layer-ubuntu');
  });
});
