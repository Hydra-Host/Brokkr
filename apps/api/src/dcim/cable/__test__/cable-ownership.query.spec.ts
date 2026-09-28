import { Prisma } from '@repo/database';
import { createPaginationConfig, type PaginationQuery } from '@repo/database/pagination';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { listOwnedCablePage } from '../cable-ownership.query';
import { cablePaginationConfig } from '../cable.pagination';

const supplierId = 'org-1';

function sqlText(sql: Prisma.Sql): string {
  return sql.text.replace(/\s+/g, ' ').trim();
}

describe('listOwnedCablePage', () => {
  const queryRaw = vi.fn();
  const run = (query: PaginationQuery) =>
    listOwnedCablePage({ $queryRaw: queryRaw }, supplierId, query, cablePaginationConfig);

  function lastQueries(): { page: Prisma.Sql; count: Prisma.Sql } {
    const [[page], [count]] = queryRaw.mock.calls;
    return { page, count };
  }

  beforeEach(() => {
    queryRaw.mockReset();
    queryRaw.mockResolvedValueOnce([{ id: 'c-2' }, { id: 'c-1' }]).mockResolvedValueOnce([{ count: 42 }]);
  });

  it('returns the page ids in database order and the total', async () => {
    const result = await run({ page: 1, pageSize: 20 });
    expect(result).toEqual({ ids: ['c-2', 'c-1'], totalItems: 42 });
  });

  it('scopes both queries to cables whose every termination is on the supplier devices', async () => {
    await run({ page: 1, pageSize: 20 });
    const { page, count } = lastQueries();
    for (const sql of [page, count]) {
      expect(sqlText(sql)).toContain('HAVING bool_and(d."supplierId" IS NOT DISTINCT FROM');
      expect(sqlText(sql)).toContain('JOIN owned o ON o."cableId" = c."id"');
      expect(sql.values).toContain(supplierId);
    }
  });

  it('pages with LIMIT/OFFSET from page and pageSize', async () => {
    await run({ page: 3, pageSize: 25 });
    const { page } = lastQueries();
    expect(sqlText(page)).toMatch(/LIMIT \$\d+ OFFSET \$\d+/);
    expect(page.values.slice(-2)).toEqual([25, 50]);
  });

  it('falls back to the config default page size and sort', async () => {
    await run({});
    const { page } = lastQueries();
    expect(sqlText(page)).toContain('ORDER BY c."createdAt" DESC, c."id" ASC');
    expect(page.values.slice(-2)).toEqual([50, 0]);
  });

  it('resolves the default sort key through sortableFields before naming the column', async () => {
    const aliased = createPaginationConfig<'createdAt'>({
      searchableFields: [],
      sortableFields: { created: 'createdAt' },
      defaultSort: [{ field: 'created', direction: 'desc' }],
    });
    await listOwnedCablePage({ $queryRaw: queryRaw }, supplierId, {}, aliased);
    const { page } = lastQueries();
    expect(sqlText(page)).toContain('ORDER BY c."createdAt" DESC, c."id" ASC');
  });

  it('applies whitelisted sorts and ignores unknown ones', async () => {
    await run({ sort: 'label:asc,bogus:desc,status:desc' });
    const { page } = lastQueries();
    expect(sqlText(page)).toContain('ORDER BY c."label" ASC, c."status" DESC, c."id" ASC');
    expect(sqlText(page)).not.toContain('bogus');
  });

  it('filters by the configured filter fields as text comparisons', async () => {
    await run({ status: 'PLANNED', type: 'CAT6' });
    const { page, count } = lastQueries();
    expect(sqlText(page)).toContain('WHERE c."status"::text = $');
    expect(sqlText(page)).toContain('AND c."type"::text = $');
    expect(page.values).toEqual(expect.arrayContaining(['PLANNED', 'CAT6']));
    expect(count.values).toEqual(expect.arrayContaining(['PLANNED', 'CAT6']));
  });

  it('searches label and description with escaped LIKE wildcards', async () => {
    await run({ search: 'a%b_c\\d' });
    const { page } = lastQueries();
    expect(sqlText(page)).toContain(`(c."label" ILIKE $`);
    expect(sqlText(page)).toContain(`OR c."description" ILIKE $`);
    expect(page.values).toContain('%a\\%b\\_c\\\\d%');
  });

  it('never interpolates port ids into the statement', async () => {
    await run({ page: 1, pageSize: 20 });
    const { page, count } = lastQueries();
    expect(page.values).toEqual([supplierId, 20, 0]);
    expect(count.values).toEqual([supplierId]);
  });
});
