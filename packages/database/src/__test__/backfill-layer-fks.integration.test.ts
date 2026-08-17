import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../index.js';

const connectionString = process.env.DATABASE_URL;

const ON_DELETE = { RESTRICT: 'r', SET_NULL: 'n' } as const;

describe.skipIf(!connectionString)('deployment layer FK on-delete behavior (shipped migration)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = createPrismaClient({ connectionString: connectionString! });
  });

  afterAll(async () => {
    if (prisma) await prisma.$disconnect();
  });

  async function onDeleteActionFor(column: string): Promise<string> {
    const rows = await prisma.$queryRawUnsafe<{ confdeltype: string }[]>(
      `SELECT c.confdeltype::text AS confdeltype
       FROM pg_constraint c
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
       WHERE c.contype = 'f'
         AND c.conrelid = '"Deployment"'::regclass
         AND a.attname = $1`,
      column,
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`No FK constraint found on "Deployment"."${column}" — was the migration applied?`);
    }
    return row.confdeltype;
  }

  it('baseLayerId FK is ON DELETE RESTRICT', async () => {
    expect(await onDeleteActionFor('baseLayerId')).toBe(ON_DELETE.RESTRICT);
  });

  it('rescueLayerId FK is ON DELETE SET NULL', async () => {
    expect(await onDeleteActionFor('rescueLayerId')).toBe(ON_DELETE.SET_NULL);
  });
});
