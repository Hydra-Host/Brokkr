import type { PaginatedResult, PaginationConfig, PaginationQuery } from './paginate';
import { buildPaginatedResponse, parseFiltersString, resolvePageSize } from './paginate';

type SortPair = { fieldPath: string; direction: 'asc' | 'desc'; nullsLast: boolean };

function fieldAccessor(item: unknown, dotPath: string): unknown {
  const parts = dotPath.split('.');
  let current: unknown = item;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = Reflect.get(current, part);
  }
  return current;
}

function coerceValue(rawValue: string, fieldType: 'string' | 'number' | 'enum' | 'date'): unknown {
  if (fieldType === 'number') {
    const n = Number(rawValue);
    return isNaN(n) ? null : n;
  }
  if (fieldType === 'date') {
    const d = new Date(rawValue);
    return isNaN(d.getTime()) ? null : d;
  }
  return rawValue;
}

function matchesOperator(
  fieldValue: unknown,
  operator: string,
  rawValue: string,
  fieldType: 'string' | 'number' | 'enum' | 'date',
): boolean {
  if (fieldValue === null || fieldValue === undefined) return false;

  const coerced = coerceValue(rawValue, fieldType);
  if (coerced === null) return false;

  switch (operator) {
    case 'eq':
      if (fieldType === 'string' || fieldType === 'enum') {
        return String(fieldValue).toLowerCase() === String(coerced).toLowerCase();
      }
      return fieldValue === coerced;
    case 'neq':
      if (fieldType === 'string' || fieldType === 'enum') {
        return String(fieldValue).toLowerCase() !== String(coerced).toLowerCase();
      }
      return fieldValue !== coerced;
    case 'gt':
      return typeof fieldValue === 'number' && typeof coerced === 'number' && fieldValue > coerced;
    case 'gte':
      return typeof fieldValue === 'number' && typeof coerced === 'number' && fieldValue >= coerced;
    case 'lt':
      return typeof fieldValue === 'number' && typeof coerced === 'number' && fieldValue < coerced;
    case 'lte':
      return typeof fieldValue === 'number' && typeof coerced === 'number' && fieldValue <= coerced;
    case 'contains':
      return String(fieldValue).toLowerCase().includes(String(rawValue).toLowerCase());
    default:
      return false;
  }
}

function resolveSortableField(entry: string | { field: string; nullsLast: boolean }): {
  fieldPath: string;
  nullsLast: boolean;
} {
  if (typeof entry === 'string') return { fieldPath: entry, nullsLast: false };
  return { fieldPath: entry.field, nullsLast: entry.nullsLast };
}

function compareSortValues(aVal: unknown, bVal: unknown, direction: 'asc' | 'desc', nullsLast: boolean): number | null {
  const aNull = aVal === null || aVal === undefined;
  const bNull = bVal === null || bVal === undefined;
  if (aNull || bNull) {
    if (aNull && bNull) return null;
    if (nullsLast) return aNull ? 1 : -1;
    return direction === 'desc' ? (aNull ? -1 : 1) : aNull ? 1 : -1;
  }
  let cmp = 0;
  if (typeof aVal === 'string' && typeof bVal === 'string') cmp = aVal.localeCompare(bVal);
  else if (typeof aVal === 'number' && typeof bVal === 'number') cmp = aVal - bVal;
  else if (aVal instanceof Date && bVal instanceof Date) cmp = aVal.getTime() - bVal.getTime();
  else cmp = String(aVal).localeCompare(String(bVal));
  if (cmp === 0) return null;
  return direction === 'desc' ? -cmp : cmp;
}

function compareBySortPairs(a: unknown, b: unknown, sortPairs: SortPair[]): number {
  for (const { fieldPath, direction, nullsLast } of sortPairs) {
    const cmp = compareSortValues(fieldAccessor(a, fieldPath), fieldAccessor(b, fieldPath), direction, nullsLast);
    if (cmp !== null) return cmp;
  }
  return 0;
}

function resolveDefaultSortPairs(config: PaginationConfig): SortPair[] {
  const sortableFields = config.sortableFields ?? {};
  return (config.defaultSort ?? []).map(({ field, direction }) => {
    const raw = sortableFields[field] ?? field;
    const { fieldPath, nullsLast } = resolveSortableField(raw);
    return { fieldPath, direction, nullsLast };
  });
}

export function paginateArray<T>(items: T[], query: PaginationQuery, config: PaginationConfig): PaginatedResult<T> {
  let filtered = [...items];

  if (query.search) {
    const searchLower = query.search.toLowerCase();
    const numericValue = Number(query.search);
    const hasNumericSearch = Boolean(config.numericSearchFields?.length) && !Number.isNaN(numericValue);
    const hasTextSearch = config.searchableFields.length > 0;

    if (hasTextSearch || hasNumericSearch) {
      filtered = filtered.filter((item) => {
        const textMatch =
          hasTextSearch &&
          config.searchableFields.some((field) => {
            const value = fieldAccessor(item, field);
            return value !== null && value !== undefined && String(value).toLowerCase().includes(searchLower);
          });
        if (textMatch) return true;
        if (!hasNumericSearch) return false;
        return (config.numericSearchFields ?? []).some((field) => fieldAccessor(item, field) === numericValue);
      });
    }
  }

  for (const [paramName, fieldPath] of Object.entries(config.filterFields ?? {})) {
    const value = query[paramName];
    if (value !== undefined && value !== null && value !== '') {
      filtered = filtered.filter((item) => {
        const fieldValue = fieldAccessor(item, fieldPath);
        return fieldValue !== null && fieldValue !== undefined && String(fieldValue) === String(value);
      });
    }
  }

  if (query.filters && typeof query.filters === 'string' && config.advancedFilterFields) {
    const parsed = parseFiltersString(query.filters);

    const eqByField = new Map<string, string[]>();
    const nonEqFilters: typeof parsed = [];

    for (const filter of parsed) {
      const fieldConfig = config.advancedFilterFields[filter.field];
      if (!fieldConfig) continue;
      if (fieldConfig.allowedValues && filter.operator === 'eq' && !fieldConfig.allowedValues.includes(filter.value)) {
        continue;
      }
      if (filter.operator === 'eq') {
        const existing = eqByField.get(filter.field) ?? [];
        existing.push(filter.value);
        eqByField.set(filter.field, existing);
      } else {
        nonEqFilters.push(filter);
      }
    }

    for (const [field, values] of eqByField) {
      const fieldConfig = config.advancedFilterFields[field];
      if (!fieldConfig) continue;
      filtered = filtered.filter((item) => {
        const fieldValue = fieldAccessor(item, fieldConfig.prismaField);
        return values.some((v) => matchesOperator(fieldValue, 'eq', v, fieldConfig.type));
      });
    }

    for (const { field, operator, value } of nonEqFilters) {
      const fieldConfig = config.advancedFilterFields[field];
      if (!fieldConfig) continue;
      filtered = filtered.filter((item) => {
        const fieldValue = fieldAccessor(item, fieldConfig.prismaField);
        // Mirror paginateQuery's optionalRelation neq → NOT EXISTS: a missing
        // / null related field is "not equal" to any concrete value.
        if (
          operator === 'neq' &&
          fieldConfig.optionalRelation &&
          !/\.(some|every|none)(\.|$)/.test(fieldConfig.prismaField) &&
          (fieldValue === null || fieldValue === undefined)
        ) {
          return true;
        }
        return matchesOperator(fieldValue, operator, value, fieldConfig.type);
      });
    }
  }

  const sortableFields = config.sortableFields ?? {};
  const defaultSortPairs = resolveDefaultSortPairs(config);
  let sortPairs: SortPair[] = [];

  if (query.sort) {
    const usedFields = new Set<string>();
    for (const pair of query.sort
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      const [field, dir] = pair.split(':');
      if (!field) continue;
      const raw = sortableFields[field];
      if (!raw) continue;
      const { fieldPath, nullsLast } = resolveSortableField(raw);
      sortPairs.push({
        fieldPath,
        direction: dir === 'desc' ? 'desc' : 'asc',
        nullsLast,
      });
      usedFields.add(fieldPath);
    }

    if (sortPairs.length === 0) {
      sortPairs = defaultSortPairs;
    } else {
      for (const pair of defaultSortPairs) {
        if (!usedFields.has(pair.fieldPath)) sortPairs.push(pair);
      }
    }
  } else {
    sortPairs = defaultSortPairs;
  }

  if (sortPairs.length > 0) {
    filtered.sort((a, b) => compareBySortPairs(a, b, sortPairs));
  }

  const page = query.page ?? 1;
  const pageSize = resolvePageSize(query.pageSize, config.defaultPageSize);
  const start = (page - 1) * pageSize;
  const paged = filtered.slice(start, start + pageSize);

  return buildPaginatedResponse(paged, filtered.length, { ...query, pageSize }, config.defaultPageSize);
}
