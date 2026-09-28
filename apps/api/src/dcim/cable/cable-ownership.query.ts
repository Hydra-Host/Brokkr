import { Prisma, type PrismaClient } from '@repo/database';
import type { PaginationConfig, PaginationQuery, SortTerm } from '@repo/database/pagination';
import { defaultSortTerms, resolvePageSize, resolveSortTerms } from '@repo/database/pagination';

export interface OwnedCablePage {
  ids: string[];
  totalItems: number;
}

// bool_and over IS NOT DISTINCT FROM: a NULL supplierId counts as not owned; no terminations yields no row.
function ownedCablesCte(supplierId: string): Prisma.Sql {
  return Prisma.sql`
    WITH owned AS (
      SELECT t."cableId"
      FROM "CableTermination" t
      LEFT JOIN "Interface" i ON t."terminationType" = 'INTERFACE' AND i.id = t."terminationId"
      LEFT JOIN "ConsolePort" cp ON t."terminationType" = 'CONSOLE_PORT' AND cp.id = t."terminationId"
      LEFT JOIN "ConsoleServerPort" csp ON t."terminationType" = 'CONSOLE_SERVER_PORT' AND csp.id = t."terminationId"
      LEFT JOIN "PowerPort" pp ON t."terminationType" = 'POWER_PORT' AND pp.id = t."terminationId"
      LEFT JOIN "PowerOutlet" po ON t."terminationType" = 'POWER_OUTLET' AND po.id = t."terminationId"
      LEFT JOIN "FrontPort" fp ON t."terminationType" = 'FRONT_PORT' AND fp.id = t."terminationId"
      LEFT JOIN "RearPort" rp ON t."terminationType" = 'REAR_PORT' AND rp.id = t."terminationId"
      LEFT JOIN "Device" d ON d.id = COALESCE(
        i."deviceId", cp."deviceId", csp."deviceId", pp."deviceId", po."deviceId", fp."deviceId", rp."deviceId"
      )
      GROUP BY t."cableId"
      HAVING bool_and(d."supplierId" IS NOT DISTINCT FROM ${supplierId})
    )
  `;
}

function containsPattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function column(name: string): Prisma.Sql {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Unsafe column name in cable pagination config: ${name}`);
  }
  return Prisma.raw(`c."${name}"`);
}

function whereClause(query: PaginationQuery, config: PaginationConfig): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];

  for (const [param, field] of Object.entries(config.filterFields ?? {})) {
    const value = query[param];
    if (value === undefined || value === null || value === '') continue;
    conditions.push(Prisma.sql`${column(field)}::text = ${String(value)}`);
  }

  if (query.search && config.searchableFields.length > 0) {
    const pattern = containsPattern(query.search);
    const matches = config.searchableFields.map((field) => Prisma.sql`${column(field)} ILIKE ${pattern} ESCAPE '\\'`);
    conditions.push(Prisma.sql`(${Prisma.join(matches, ' OR ')})`);
  }

  return conditions.length > 0 ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}

function orderTerm(term: SortTerm): Prisma.Sql {
  const direction = Prisma.raw(term.direction === 'desc' ? 'DESC' : 'ASC');
  return term.nullsLast
    ? Prisma.sql`${column(term.field)} ${direction} NULLS LAST`
    : Prisma.sql`${column(term.field)} ${direction}`;
}

function orderByClause(query: PaginationQuery, config: PaginationConfig): Prisma.Sql {
  const requested = resolveSortTerms(query.sort ?? '', config.sortableFields ?? {});
  const terms = (requested.length > 0 ? requested : defaultSortTerms(config)).map(orderTerm);
  // Trailing id keeps LIMIT/OFFSET pages stable when the sort key ties.
  terms.push(Prisma.sql`c."id" ASC`);
  return Prisma.sql`ORDER BY ${Prisma.join(terms, ', ')}`;
}

// Raw SQL: the Prisma IN-list form exceeded the bind-parameter limit on large fleets.
export async function listOwnedCablePage(
  client: Pick<PrismaClient, '$queryRaw'>,
  supplierId: string,
  query: PaginationQuery,
  config: PaginationConfig,
): Promise<OwnedCablePage> {
  const cte = ownedCablesCte(supplierId);
  const where = whereClause(query, config);
  const pageSize = resolvePageSize(query.pageSize, config.defaultPageSize);
  const offset = ((query.page ?? 1) - 1) * pageSize;

  const [rows, counts] = await Promise.all([
    client.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      ${cte}
      SELECT c."id" FROM "Cable" c
      JOIN owned o ON o."cableId" = c."id"
      ${where}
      ${orderByClause(query, config)}
      LIMIT ${pageSize} OFFSET ${offset}
    `),
    client.$queryRaw<Array<{ count: number }>>(Prisma.sql`
      ${cte}
      SELECT count(*)::int AS "count" FROM "Cable" c
      JOIN owned o ON o."cableId" = c."id"
      ${where}
    `),
  ]);

  return { ids: rows.map((row) => row.id), totalItems: counts[0]?.count ?? 0 };
}
