import { MIB_PER_GIB } from '@repo/utils';
import { describe, expect, it } from 'vitest';
import {
  buildPaginatedResponse,
  createPaginationConfig,
  paginateQuery,
  parseFiltersString,
  type PaginationConfig,
  type PaginationQuery,
} from './paginate';

function makeDelegate(rows: unknown[] = [], total = rows.length) {
  const calls: { findMany?: Record<string, unknown>; count?: Record<string, unknown> } = {};
  return {
    calls,
    delegate: {
      findMany: (args: Record<string, unknown>) => {
        calls.findMany = args;
        return Promise.resolve(rows);
      },
      count: (args: Record<string, unknown>) => {
        calls.count = args;
        return Promise.resolve(total);
      },
    },
  };
}

const config: PaginationConfig = {
  searchableFields: ['name', 'user.email'],
  numericSearchFields: ['memory'],
  filterFields: { status: 'status', zone: 'zone.slug' },
  sortableFields: {
    name: 'name',
    email: 'user.email',
    price: { field: 'price', nullsLast: true },
    id: 'id',
  },
  defaultSort: [
    { field: 'name', direction: 'asc' },
    { field: 'id', direction: 'asc' },
  ],
  defaultPageSize: 10,
  advancedFilterFields: {
    role: { prismaField: 'role', type: 'enum', allowedValues: ['Baremetal', 'Bridge'] },
    memory: { prismaField: 'memory', type: 'number' },
    createdAt: { prismaField: 'createdAt', type: 'date' },
    name: { prismaField: 'name', type: 'string' },
  },
};

async function args(query: PaginationQuery, cfg: PaginationConfig = config) {
  const { calls, delegate } = makeDelegate();
  await paginateQuery(delegate, query, cfg);
  return calls.findMany!;
}

describe('parseFiltersString', () => {
  it('parses pipe-delimited field:operator:value tuples', () => {
    expect(parseFiltersString('role:eq:Baremetal|memory:gt:32')).toEqual([
      { field: 'role', operator: 'eq', value: 'Baremetal' },
      { field: 'memory', operator: 'gt', value: '32' },
    ]);
  });

  it('rejoins values that themselves contain colons', () => {
    expect(parseFiltersString('createdAt:gte:2026-01-01T00:00:00Z')).toEqual([
      { field: 'createdAt', operator: 'gte', value: '2026-01-01T00:00:00Z' },
    ]);
  });

  it('drops malformed tuples, unknown operators, and empty parts', () => {
    expect(parseFiltersString('justfield|name:eq|name:like:x|:eq:x|name:eq:')).toEqual([]);
  });
});

describe('buildPaginatedResponse', () => {
  it('defaults to page 1 / pageSize 20 and computes totalPages with ceiling', () => {
    const result = buildPaginatedResponse(['a'], 41, {});
    expect(result.meta).toEqual({ page: 1, pageSize: 20, totalItems: 41, totalPages: 3 });
  });

  it('echoes explicit page/pageSize and honors the config defaultPageSize', () => {
    expect(buildPaginatedResponse([], 100, { page: 3, pageSize: 25 }).meta).toEqual({
      page: 3,
      pageSize: 25,
      totalItems: 100,
      totalPages: 4,
    });
    expect(buildPaginatedResponse([], 100, {}, 10).meta.pageSize).toBe(10);
  });

  it('rejects non-positive pageSize so totalPages stays finite', () => {
    const result = buildPaginatedResponse([], 10, { pageSize: 0 }, 5);
    expect(result.meta.pageSize).toBe(5);
    expect(result.meta.totalPages).toBe(2);
  });
});

describe('paginateQuery: paging', () => {
  it('defaults to page 1 with the config page size', async () => {
    const a = await args({});
    expect(a.skip).toBe(0);
    expect(a.take).toBe(10);
  });

  it('translates page/pageSize into skip/take', async () => {
    const a = await args({ page: 3, pageSize: 25 });
    expect(a.skip).toBe(50);
    expect(a.take).toBe(25);
  });

  it('clamps non-positive pageSize for skip/take as well as the envelope', async () => {
    const a = await args({ pageSize: 0 });
    expect(a.take).toBe(10);
    expect(a.skip).toBe(0);
    const { delegate } = makeDelegate([], 0);
    const result = await paginateQuery(delegate, { pageSize: 0 }, config);
    expect(result.meta.pageSize).toBe(10);
  });

  it('returns the envelope built from findMany rows and count', async () => {
    const rows = [{ id: '1' }, { id: '2' }];
    const { delegate } = makeDelegate(rows, 12);
    const result = await paginateQuery(delegate, { page: 2, pageSize: 2 }, config);
    expect(result.data).toBe(rows);
    expect(result.meta).toEqual({ page: 2, pageSize: 2, totalItems: 12, totalPages: 6 });
  });
});

describe('paginateQuery: sorting', () => {
  it('applies the default sort when no sort param is given', async () => {
    const a = await args({});
    expect(a.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
  });

  it('allowlists sort fields — an unrecognized field falls back to the default sort', async () => {
    const a = await args({ sort: 'hackerField:desc' });
    expect(a.orderBy).toEqual([{ name: 'asc' }, { id: 'asc' }]);
  });

  it('builds nested orderBy for dot paths and coerces unknown directions to asc', async () => {
    const a = await args({ sort: 'email:sideways' });
    expect(a.orderBy).toEqual([{ user: { email: 'asc' } }, { name: 'asc' }, { id: 'asc' }]);
  });

  it('appends only the default tie-breakers the user sort does not already cover', async () => {
    const a = await args({ sort: 'name:desc' });
    expect(a.orderBy).toEqual([{ name: 'desc' }, { id: 'asc' }]);
  });

  it('uses extended nulls-last syntax for sortable entries flagged nullsLast', async () => {
    const a = await args({ sort: 'price:desc' });
    expect(a.orderBy).toEqual([{ price: { sort: 'desc', nulls: 'last' } }, { name: 'asc' }, { id: 'asc' }]);
  });
});

describe('paginateQuery: search and simple filters', () => {
  it('ORs case-insensitive contains across searchable fields', async () => {
    const a = await args({ search: 'gpu' });
    expect(a.where).toEqual({
      AND: [
        {
          OR: [
            { name: { contains: 'gpu', mode: 'insensitive' } },
            { user: { email: { contains: 'gpu', mode: 'insensitive' } } },
          ],
        },
      ],
    });
  });

  it('adds numeric equality conditions when the search term parses as a number', async () => {
    const a = await args({ search: '64' });
    const and = (a.where as { AND: Array<{ OR: unknown[] }> }).AND;
    expect(and[0]?.OR).toContainEqual({ memory: 64 });
  });

  it('applies filterFields as nested exact matches, skipping empty values', async () => {
    const a = await args({ status: 'active', zone: 'us-east', search: undefined });
    expect(a.where).toEqual({ AND: [{ status: 'active' }, { zone: { slug: 'us-east' } }] });

    const empty = await args({ status: '' });
    expect(empty.where).toEqual({});
  });
});

describe('paginateQuery: advanced filters', () => {
  it('ORs multiple eq values on the same field and enforces allowedValues', async () => {
    const a = await args({ filters: 'role:eq:Baremetal|role:eq:Bridge|role:eq:Superuser' });
    expect(a.where).toEqual({
      AND: [{ OR: [{ role: 'Baremetal' }, { role: 'Bridge' }] }],
    });
  });

  it('coerces number and date fields, dropping values that fail coercion', async () => {
    const a = await args({ filters: 'memory:gt:32|memory:lt:notanumber|createdAt:gte:2026-01-01' });
    expect(a.where).toEqual({
      AND: [{ memory: { gt: 32 } }, { createdAt: { gte: new Date('2026-01-01') } }],
    });
  });

  it('treats string eq/contains as case-insensitive and ignores unconfigured fields', async () => {
    const a = await args({ filters: 'name:contains:h100|name:eq:exact|nosuchfield:eq:x' });
    expect(a.where).toEqual({
      AND: [{ name: { equals: 'exact', mode: 'insensitive' } }, { name: { contains: 'h100', mode: 'insensitive' } }],
    });
  });

  it('compiles optionalRelation neq as NOT of the positive match so missing relations stay included', async () => {
    const cfg: PaginationConfig = {
      ...config,
      advancedFilterFields: {
        ...config.advancedFilterFields,
        bridgeVersion: { prismaField: 'bridge.bridgeVersion', type: 'string', optionalRelation: true },
        lastSeenAt: { prismaField: 'bridge.lastSeenAt', type: 'date', optionalRelation: true },
      },
    };
    const a = await args({ filters: 'bridgeVersion:neq:v1.4.2|lastSeenAt:neq:2026-01-01' }, cfg);
    expect(a.where).toEqual({
      AND: [
        { NOT: { bridge: { bridgeVersion: { equals: 'v1.4.2', mode: 'insensitive' } } } },
        { NOT: { bridge: { lastSeenAt: new Date('2026-01-01') } } },
      ],
    });
  });

  it('keeps missing optional relations while negating the scaled memory bucket', async () => {
    const cfg: PaginationConfig = {
      ...config,
      advancedFilterFields: {
        memory: {
          prismaField: 'memoryConfig.totalSizeMb',
          type: 'number',
          optionalRelation: true,
          valueMultiplier: MIB_PER_GIB,
        },
      },
    };
    const a = await args({ filters: 'memory:neq:64' }, cfg);
    expect(a.where).toEqual({
      AND: [{ NOT: { memoryConfig: { totalSizeMb: { gte: 65024, lt: 66048 } } } }],
    });
  });

  it('keeps optionalRelation eq as a nested filter that requires the relation', async () => {
    const cfg: PaginationConfig = {
      ...config,
      advancedFilterFields: {
        bridgeVersion: { prismaField: 'bridge.bridgeVersion', type: 'string', optionalRelation: true },
      },
    };
    const a = await args({ filters: 'bridgeVersion:eq:v1.4.2' }, cfg);
    expect(a.where).toEqual({
      AND: [{ bridge: { bridgeVersion: { equals: 'v1.4.2', mode: 'insensitive' } } }],
    });
  });

  it('does not rewrite neq on to-many some-paths even when optionalRelation is set', async () => {
    const cfg: PaginationConfig = {
      ...config,
      advancedFilterFields: {
        gpuModel: { prismaField: 'gpus.some.model', type: 'string', optionalRelation: true },
      },
    };
    const a = await args({ filters: 'gpuModel:neq:A100' }, cfg);
    expect(a.where).toEqual({
      AND: [{ gpus: { some: { model: { not: 'A100', mode: 'insensitive' } } } }],
    });
  });

  it('maps GB memory filters to the rounded MiB bucket', async () => {
    const cfg: PaginationConfig = {
      ...config,
      advancedFilterFields: {
        memory: { prismaField: 'memoryConfig.totalSizeMb', type: 'number', valueMultiplier: MIB_PER_GIB },
      },
    };
    const a = await args({ filters: 'memory:eq:128|memory:neq:64|memory:gte:256' }, cfg);
    expect(a.where).toEqual({
      AND: [
        { memoryConfig: { totalSizeMb: { gte: 130560, lt: 131584 } } },
        {
          OR: [{ memoryConfig: { totalSizeMb: { lt: 65024 } } }, { memoryConfig: { totalSizeMb: { gte: 66048 } } }],
        },
        { memoryConfig: { totalSizeMb: { gte: 262144 } } },
      ],
    });
  });

  it('ORs multiple scaled memory buckets', async () => {
    const cfg: PaginationConfig = {
      ...config,
      advancedFilterFields: {
        memory: { prismaField: 'memoryConfig.totalSizeMb', type: 'number', valueMultiplier: MIB_PER_GIB },
      },
    };
    const a = await args({ filters: 'memory:eq:64|memory:eq:128' }, cfg);
    expect(a.where).toEqual({
      AND: [
        {
          OR: [
            { memoryConfig: { totalSizeMb: { gte: 65024, lt: 66048 } } },
            { memoryConfig: { totalSizeMb: { gte: 130560, lt: 131584 } } },
          ],
        },
      ],
    });
  });
});

describe('paginateQuery: base args merging', () => {
  it('merges the base where with pagination conditions under AND and preserves include/select', async () => {
    const { calls, delegate } = makeDelegate();
    await paginateQuery(delegate, { search: 'gpu' }, config, {
      where: { organizationId: 'org-1', AND: [{ deletedAt: null }] },
      include: { user: true },
    });

    expect(calls.findMany!.include).toEqual({ user: true });
    expect(calls.findMany!.where).toEqual({
      organizationId: 'org-1',
      AND: [
        { deletedAt: null },
        {
          OR: [
            { name: { contains: 'gpu', mode: 'insensitive' } },
            { user: { email: { contains: 'gpu', mode: 'insensitive' } } },
          ],
        },
      ],
    });
    expect(calls.count).toEqual({ where: calls.findMany!.where });
  });
});

describe('createPaginationConfig', () => {
  it('returns the config unchanged (compile-time helper only)', () => {
    const cfg = createPaginationConfig<'name' | 'id'>({
      searchableFields: ['name'],
      filterFields: { name: 'name' },
      sortableFields: { name: 'name' },
      defaultSort: [{ field: 'name', direction: 'asc' }],
      defaultPageSize: 5,
    });
    expect(cfg.defaultPageSize).toBe(5);
    expect(cfg.searchableFields).toEqual(['name']);
  });
});
