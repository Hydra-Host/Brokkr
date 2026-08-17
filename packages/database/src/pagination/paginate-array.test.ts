import { describe, expect, it } from 'vitest';
import type { PaginationConfig } from './paginate';
import { paginateArray } from './paginate-array';

type Item = { id: number; name: string; role: string; memory: number | null; user: { email: string } };

const items: Item[] = [
  { id: 1, name: 'alpha', role: 'Baremetal', memory: 64, user: { email: 'a@x.test' } },
  { id: 2, name: 'Bravo', role: 'Bridge', memory: 32, user: { email: 'b@x.test' } },
  { id: 3, name: 'charlie', role: 'Baremetal', memory: null, user: { email: 'c@x.test' } },
  { id: 4, name: 'delta', role: 'Baremetal', memory: 128, user: { email: 'd@x.test' } },
];

const config: PaginationConfig = {
  searchableFields: ['name', 'user.email'],
  numericSearchFields: ['memory'],
  filterFields: { role: 'role' },
  sortableFields: {
    name: 'name',
    id: 'id',
    memory: { field: 'memory', nullsLast: true },
  },
  defaultSort: [
    { field: 'name', direction: 'asc' },
    { field: 'id', direction: 'asc' },
  ],
  defaultPageSize: 2,
  advancedFilterFields: {
    role: { prismaField: 'role', type: 'enum', allowedValues: ['Baremetal', 'Bridge'] },
    memory: { prismaField: 'memory', type: 'number' },
  },
};

describe('paginateArray', () => {
  it('searches case-insensitively across dot-path fields', () => {
    const result = paginateArray(items, { search: 'BRAVO' }, config);
    expect(result.data.map((i) => i.id)).toEqual([2]);
    expect(result.meta.totalItems).toBe(1);
  });

  it('applies simple filterFields with string equality', () => {
    const result = paginateArray(items, { role: 'Bridge', pageSize: 10 }, config);
    expect(result.data.map((i) => i.id)).toEqual([2]);
  });

  it('ORs repeated eq advanced filters and ANDs the rest, coercing numbers', () => {
    const result = paginateArray(
      items,
      { filters: 'role:eq:Baremetal|role:eq:Bridge|memory:gte:64', pageSize: 10 },
      config,
    );
    expect(result.data.map((i) => i.id).sort()).toEqual([1, 4]);
  });

  it('excludes null field values from comparison filters', () => {
    const result = paginateArray(items, { filters: 'memory:lte:9999', pageSize: 10 }, config);
    expect(result.data.map((i) => i.id).sort()).toEqual([1, 2, 4]);
  });

  it('includes null/missing optionalRelation fields for neq', () => {
    type BridgeItem = { id: number; bridge: { bridgeVersion: string | null } | null };
    const bridges: BridgeItem[] = [
      { id: 1, bridge: { bridgeVersion: 'v1.4.2' } },
      { id: 2, bridge: { bridgeVersion: 'v2.0.0' } },
      { id: 3, bridge: { bridgeVersion: null } },
      { id: 4, bridge: null },
    ];
    const cfg: PaginationConfig = {
      searchableFields: [],
      filterFields: {},
      sortableFields: { id: 'id' },
      defaultSort: [{ field: 'id', direction: 'asc' }],
      defaultPageSize: 10,
      advancedFilterFields: {
        bridgeVersion: { prismaField: 'bridge.bridgeVersion', type: 'string', optionalRelation: true },
      },
    };
    const result = paginateArray(bridges, { filters: 'bridgeVersion:neq:v1.4.2', pageSize: 10 }, cfg);
    expect(result.data.map((i) => i.id)).toEqual([2, 3, 4]);
  });

  it('matches numericSearchFields when the search term is numeric', () => {
    const result = paginateArray(items, { search: '64', pageSize: 10 }, config);
    expect(result.data.map((i) => i.id)).toEqual([1]);
  });

  it('sorts by an allowlisted field with nullsLast keeping nulls at the end in both directions', () => {
    const asc = paginateArray(items, { sort: 'memory:asc', pageSize: 10 }, config);
    expect(asc.data.map((i) => i.id)).toEqual([2, 1, 4, 3]);
    const desc = paginateArray(items, { sort: 'memory:desc', pageSize: 10 }, config);
    expect(desc.data.map((i) => i.id)).toEqual([4, 1, 2, 3]);
  });

  it('falls back to defaultSort when every requested sort field is invalid', () => {
    const result = paginateArray(items, { sort: 'unknown:desc', pageSize: 10 }, config);
    expect(result.data.map((i) => i.name)).toEqual(['alpha', 'Bravo', 'charlie', 'delta']);
  });

  it('appends defaultSort tie-breakers after a user-supplied sort', () => {
    const tied: Item[] = [
      { id: 2, name: 'same', role: 'Bridge', memory: 1, user: { email: 'b@x.test' } },
      { id: 1, name: 'same', role: 'Baremetal', memory: 1, user: { email: 'a@x.test' } },
    ];
    const result = paginateArray(tied, { sort: 'name:asc', pageSize: 10 }, config);
    expect(result.data.map((i) => i.id)).toEqual([1, 2]);
  });

  it('falls back to the default sort and slices pages with a correct envelope', () => {
    const page2 = paginateArray(items, { page: 2 }, config);
    expect(page2.data.map((i) => i.name)).toEqual(['charlie', 'delta']);
    expect(page2.meta).toEqual({ page: 2, pageSize: 2, totalItems: 4, totalPages: 2 });
  });

  it('guards pageSize <= 0 so totalPages stays finite', () => {
    const result = paginateArray(items, { pageSize: 0 }, config);
    expect(result.meta.pageSize).toBe(2);
    expect(Number.isFinite(result.meta.totalPages)).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it('leaves items unchanged when search is set but no searchable fields are configured', () => {
    const bare: PaginationConfig = {
      searchableFields: [],
      filterFields: {},
      sortableFields: {},
      defaultSort: [],
      defaultPageSize: 10,
    };
    const result = paginateArray(items, { search: 'alpha', pageSize: 10 }, bare);
    expect(result.data).toHaveLength(4);
  });
});
