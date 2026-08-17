import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  join(here, '..', '..', 'prisma', 'migrations', '20260626000200_drop_operating_system_tables', 'migration.sql'),
  'utf8',
);

function abortGuardStatement(deploymentTable: string): string {
  const match = MIGRATION_SQL.match(/DO\s+\$\$[\s\S]*?Aborting:[\s\S]*?\$\$;/);
  if (!match) throw new Error('Could not locate the fail-closed DO-block guard in migration.sql');
  return match[0].replace(/"Deployment"/g, `"${deploymentTable}"`);
}

describe.skipIf(!connectionString)('drop_operating_system_tables abort guard', () => {
  let prisma: PrismaClient;
  const DEPLOYMENT = '_guard_deployment';

  const insertDeployment = (id: string, osId: string | null, baseLayerId: string | null, ended: boolean) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "${DEPLOYMENT}" ("id", "operatingSystemId", "baseLayerId", "endDate")
        VALUES ($1, $2, $3, $4)`,
      id,
      osId,
      baseLayerId,
      ended ? new Date() : null,
    );
  const runGuard = () => prisma.$executeRawUnsafe(abortGuardStatement(DEPLOYMENT));

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: connectionString! });
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${DEPLOYMENT}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${DEPLOYMENT}" (
        "id" TEXT PRIMARY KEY,
        "operatingSystemId" TEXT,
        "baseLayerId" TEXT,
        "endDate" TIMESTAMP(3)
      )`,
    );
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(`TRUNCATE "${DEPLOYMENT}"`);
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${DEPLOYMENT}"`);
      await prisma.$disconnect();
    }
  });

  it('aborts when an active deployment is unmapped (operatingSystemId set, baseLayerId NULL)', async () => {
    await insertDeployment('dep-unmapped', 'os-ubuntu', null, false);
    await expect(runGuard()).rejects.toThrow(/Aborting/);
  });

  it('passes when every active deployment is mapped (baseLayerId set)', async () => {
    await insertDeployment('dep-mapped', 'os-ubuntu', 'layer-ubuntu', false);
    await expect(runGuard()).resolves.toBeTypeOf('number');
  });

  it('ignores an ended deployment that is unmapped (endDate IS NOT NULL)', async () => {
    await insertDeployment('dep-ended', 'os-legacy', null, true);
    await expect(runGuard()).resolves.toBeTypeOf('number');
  });
});
