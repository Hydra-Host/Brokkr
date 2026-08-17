import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION_SQL = readFileSync(
  join(here, '..', '..', 'prisma', 'migrations', '20260626000125_fix_base_layer_fk_and_indices', 'migration.sql'),
  'utf8',
);

function auditBlock(deploymentTable: string): string {
  const match = MIGRATION_SQL.match(/DO\s+\$\$[\s\S]*?Backfill results[\s\S]*?\$\$;/);
  if (!match) throw new Error('Could not locate the audit DO-block in migration 00125');
  return match[0].replace(/"Deployment"/g, `"${deploymentTable}"`);
}

function auditBlockEscalated(deploymentTable: string): string {
  const block = auditBlock(deploymentTable);
  return block.replace('RAISE WARNING', 'RAISE EXCEPTION');
}

describe.skipIf(!connectionString)('migration 00125 post-backfill audit', () => {
  let prisma: PrismaClient;
  const DEPLOYMENT = '_audit_deployment';

  const insertDeployment = (
    id: string,
    opts: {
      osId?: string | null;
      rescueOsId?: string | null;
      baseLayerId?: string | null;
      rescueLayerId?: string | null;
      ended?: boolean;
    },
  ) =>
    prisma.$executeRawUnsafe(
      `INSERT INTO "${DEPLOYMENT}" ("id", "operatingSystemId", "currentRescueOperatingSystemId", "baseLayerId", "rescueLayerId", "endDate")
        VALUES ($1, $2, $3, $4, $5, $6)`,
      id,
      opts.osId ?? null,
      opts.rescueOsId ?? null,
      opts.baseLayerId ?? null,
      opts.rescueLayerId ?? null,
      opts.ended ? new Date() : null,
    );

  beforeAll(async () => {
    prisma = createPrismaClient({ connectionString: connectionString! });
    await prisma.$executeRawUnsafe(`DROP TABLE IF EXISTS "${DEPLOYMENT}"`);
    await prisma.$executeRawUnsafe(
      `CREATE TABLE "${DEPLOYMENT}" (
        "id" TEXT PRIMARY KEY,
        "operatingSystemId" TEXT,
        "currentRescueOperatingSystemId" TEXT,
        "baseLayerId" TEXT,
        "rescueLayerId" TEXT,
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

  it('executes cleanly with no deployments (empty table)', async () => {
    await expect(prisma.$executeRawUnsafe(auditBlock(DEPLOYMENT))).resolves.toBeTypeOf('number');
  });

  it('does not warn when all active deployments are fully mapped', async () => {
    await insertDeployment('dep-mapped', {
      osId: 'os-ubuntu',
      rescueOsId: 'os-rescue',
      baseLayerId: 'layer-ubuntu',
      rescueLayerId: 'layer-rescue',
    });
    await expect(prisma.$executeRawUnsafe(auditBlockEscalated(DEPLOYMENT))).resolves.toBeTypeOf('number');
  });

  it('warns when an active deployment has unmapped base (operatingSystemId set, baseLayerId NULL)', async () => {
    await insertDeployment('dep-unmapped-base', {
      osId: 'os-ubuntu',
      baseLayerId: null,
    });
    await expect(prisma.$executeRawUnsafe(auditBlockEscalated(DEPLOYMENT))).rejects.toThrow(/Backfill incomplete/);
  });

  it('does not warn for ended deployments with unmapped base', async () => {
    await insertDeployment('dep-ended', {
      osId: 'os-legacy',
      baseLayerId: null,
      ended: true,
    });
    await expect(prisma.$executeRawUnsafe(auditBlockEscalated(DEPLOYMENT))).resolves.toBeTypeOf('number');
  });

  it('does not warn when base is mapped but rescue is unmapped', async () => {
    await insertDeployment('dep-rescue-unmapped', {
      osId: 'os-ubuntu',
      rescueOsId: 'os-rescue',
      baseLayerId: 'layer-ubuntu',
      rescueLayerId: null,
    });
    await expect(prisma.$executeRawUnsafe(auditBlockEscalated(DEPLOYMENT))).resolves.toBeTypeOf('number');
  });
});
