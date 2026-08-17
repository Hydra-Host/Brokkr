import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUDITED_TABLES } from './audited-tables.js';
import { createPrismaClient } from './index.js';

describe.skipIf(!process.env.DATABASE_URL)('changelog_trigger invariant', () => {
  const prisma = createPrismaClient({ connectionString: process.env.DATABASE_URL! });
  let triggeredTables: Set<string>;

  beforeAll(async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT c.relname AS table_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE t.tgname = 'changelog_trigger'
        AND NOT t.tgisinternal
        AND n.nspname = 'public';
    `;
    triggeredTables = new Set(rows.map((row) => row.table_name));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it.each(AUDITED_TABLES)('table "%s" has changelog_trigger attached', (table) => {
    expect(triggeredTables.has(table)).toBe(true);
  });
});
