export interface AdvancedFilterFieldConfig {
  prismaField: string;
  type: 'string' | 'number' | 'enum' | 'date';
  allowedValues?: string[];
  valueMultiplier?: number;
  // To-one relation whose absence counts as null for `neq`: compiles `neq` as
  // NOT EXISTS so missing rows are kept. Ignored for to-many (`.some`/`.every`/`.none`).
  optionalRelation?: boolean;
}

export interface PaginationConfig {
  searchableFields: string[];
  numericSearchFields?: string[];
  filterFields?: Record<string, string>;
  sortableFields?: Record<string, string | { field: string; nullsLast: boolean }>;
  defaultSort?: Array<{ field: string; direction: 'asc' | 'desc' }>;
  defaultPageSize?: number;
  advancedFilterFields?: Record<string, AdvancedFilterFieldConfig>;
}

export type ModelFieldPaths<TModel, TRelations extends Record<string, unknown> = Record<never, never>> =
  | (keyof TModel & string)
  | {
      [K in keyof TRelations & string]: `${K}.${keyof TRelations[K] & string}`;
    }[keyof TRelations & string]
  | {
      [K in keyof TRelations & string]: `${K}._count`;
    }[keyof TRelations & string];

export function createPaginationConfig<TField extends string>(config: {
  searchableFields: NoInfer<TField>[];
  numericSearchFields?: NoInfer<TField>[];
  filterFields?: Record<string, NoInfer<TField>>;
  sortableFields: Record<string, NoInfer<TField> | { field: NoInfer<TField>; nullsLast: boolean }>;
  defaultSort: Array<{ field: string; direction: 'asc' | 'desc' }>;
  defaultPageSize?: number;
  advancedFilterFields?: Record<string, AdvancedFilterFieldConfig>;
}): PaginationConfig {
  return config;
}

export interface PaginationQuery {
  page?: number;
  pageSize?: number;
  sort?: string;
  search?: string;
  [key: string]: unknown;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    totalItems: number;
    totalPages: number;
  };
}

function nestPath(fieldPath: string, leaf: unknown): Record<string, unknown> {
  const [head, ...rest] = fieldPath.split('.');
  if (head === undefined || head === '') return {};
  if (rest.length === 0) return { [head]: leaf };
  return { [head]: nestPath(rest.join('.'), leaf) };
}

function buildNestedOrderBy(fieldPath: string, direction: 'asc' | 'desc', nullsLast = false): Record<string, unknown> {
  const sortValue: unknown = nullsLast ? { sort: direction, nulls: 'last' } : direction;
  return nestPath(fieldPath, sortValue);
}

function buildNestedWhere(fieldPath: string, condition: unknown): Record<string, unknown> {
  return nestPath(fieldPath, condition);
}

function resolveSortableField(entry: string | { field: string; nullsLast: boolean }): {
  prismaField: string;
  nullsLast: boolean;
} {
  if (typeof entry === 'string') return { prismaField: entry, nullsLast: false };
  return { prismaField: entry.field, nullsLast: entry.nullsLast };
}

function parseSortString(
  sort: string,
  sortableFields: Record<string, string | { field: string; nullsLast: boolean }>,
): { orderBy: Record<string, unknown>[]; usedFields: Set<string> } {
  const orderBy: Record<string, unknown>[] = [];
  const usedFields = new Set<string>();

  const pairs = sort
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const pair of pairs) {
    const [field, dir] = pair.split(':');
    if (!field || !sortableFields[field]) continue;

    const direction = dir === 'desc' ? 'desc' : 'asc';
    const { prismaField, nullsLast } = resolveSortableField(sortableFields[field]);
    orderBy.push(buildNestedOrderBy(prismaField, direction, nullsLast));
    usedFields.add(prismaField);
  }

  return { orderBy, usedFields };
}

export const VALID_OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']);

export function resolvePageSize(requested: number | undefined, fallback?: number): number {
  const candidate = requested ?? fallback ?? 20;
  return candidate > 0 ? candidate : (fallback ?? 20);
}

export function parseFiltersString(filtersStr: string): Array<{ field: string; operator: string; value: string }> {
  return filtersStr
    .split('|')
    .map((tuple) => {
      const parts = tuple.split(':');
      if (parts.length < 3) return null;
      const [field, operator, ...rest] = parts;
      const value = rest.join(':');
      if (!field || !operator || !value || !VALID_OPERATORS.has(operator)) return null;
      return { field, operator, value };
    })
    .filter((t): t is { field: string; operator: string; value: string } => t !== null);
}

function buildOperatorCondition(
  operator: string,
  rawValue: string,
  fieldType: 'string' | 'number' | 'enum' | 'date',
  fieldPath: string,
  valueMultiplier?: number,
): Record<string, unknown> | null {
  let value: unknown = rawValue;
  let numericValue: number | undefined;
  if (fieldType === 'number') {
    numericValue = Number(rawValue);
    if (Number.isNaN(numericValue)) return null;
    if (valueMultiplier !== undefined) numericValue *= valueMultiplier;
    value = numericValue;
  } else if (fieldType === 'date') {
    const d = new Date(rawValue);
    if (Number.isNaN(d.getTime())) return null;
    value = d;
  }

  const caseInsensitive = fieldType === 'string';

  if (numericValue !== undefined && valueMultiplier !== undefined && (operator === 'eq' || operator === 'neq')) {
    const halfBucket = valueMultiplier / 2;
    const lo = numericValue - halfBucket;
    const hi = numericValue + halfBucket;
    if (operator === 'eq') return buildNestedWhere(fieldPath, { gte: lo, lt: hi });
    return { OR: [buildNestedWhere(fieldPath, { lt: lo }), buildNestedWhere(fieldPath, { gte: hi })] };
  }

  switch (operator) {
    case 'eq':
      return buildNestedWhere(fieldPath, caseInsensitive ? { equals: value, mode: 'insensitive' } : value);
    case 'neq':
      return buildNestedWhere(fieldPath, caseInsensitive ? { not: value, mode: 'insensitive' } : { not: value });
    case 'gt':
      return buildNestedWhere(fieldPath, { gt: value });
    case 'gte':
      return buildNestedWhere(fieldPath, { gte: value });
    case 'lt':
      return buildNestedWhere(fieldPath, { lt: value });
    case 'lte':
      return buildNestedWhere(fieldPath, { lte: value });
    case 'contains':
      return buildNestedWhere(fieldPath, { contains: rawValue, mode: 'insensitive' });
    default:
      return null;
  }
}

function buildPaginationArgs(
  query: PaginationQuery,
  config: PaginationConfig,
): {
  where: Record<string, unknown>;
  orderBy: Record<string, unknown>[];
  skip: number;
  take: number;
} {
  const page = query.page ?? 1;
  const pageSize = resolvePageSize(query.pageSize, config.defaultPageSize);
  const defaultSort = config.defaultSort ?? [];
  const sortableFields = config.sortableFields ?? {};

  const resolvePrismaField = (field: string) => {
    const entry = sortableFields[field];
    return entry ? resolveSortableField(entry).prismaField : field;
  };
  const resolveDefault = (s: { field: string; direction: 'asc' | 'desc' }) => {
    const entry = sortableFields[s.field];
    if (!entry) return buildNestedOrderBy(s.field, s.direction);
    const { prismaField, nullsLast } = resolveSortableField(entry);
    return buildNestedOrderBy(prismaField, s.direction, nullsLast);
  };

  let orderBy: Record<string, unknown>[];
  if (query.sort) {
    const parsed = parseSortString(query.sort, sortableFields);
    orderBy = parsed.orderBy;
    if (orderBy.length === 0) {
      orderBy = defaultSort.map(resolveDefault);
    } else {
      // Non-unique user sort isn't a total order — offset pagination could skip/dup rows across pages; append uncovered default tie-breakers (they end in a unique key).
      for (const s of defaultSort) {
        if (!parsed.usedFields.has(resolvePrismaField(s.field))) {
          orderBy.push(resolveDefault(s));
        }
      }
    }
  } else {
    orderBy = defaultSort.map(resolveDefault);
  }

  const whereConditions: Record<string, unknown>[] = [];

  if (query.search) {
    const searchConditions: Record<string, unknown>[] = [];

    if (config.searchableFields.length > 0) {
      for (const field of config.searchableFields) {
        searchConditions.push(buildNestedWhere(field, { contains: query.search, mode: 'insensitive' }));
      }
    }

    const numericValue = Number(query.search);
    if (config.numericSearchFields?.length && !Number.isNaN(numericValue)) {
      for (const field of config.numericSearchFields) {
        searchConditions.push(buildNestedWhere(field, numericValue));
      }
    }

    if (searchConditions.length > 0) {
      whereConditions.push({ OR: searchConditions });
    }
  }

  for (const [paramName, prismaField] of Object.entries(config.filterFields ?? {})) {
    const value = query[paramName];
    if (value !== undefined && value !== null && value !== '') {
      whereConditions.push(buildNestedWhere(prismaField, value));
    }
  }

  if (query.filters && typeof query.filters === 'string' && config.advancedFilterFields) {
    const parsed = parseFiltersString(query.filters);

    const eqByField = new Map<string, string[]>();
    const otherFilters: Array<{ field: string; operator: string; value: string }> = [];

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
        otherFilters.push(filter);
      }
    }

    for (const [field, values] of eqByField) {
      const fieldConfig = config.advancedFilterFields[field]!;
      const first = values[0];
      if (values.length === 1 && first !== undefined) {
        const condition = buildOperatorCondition(
          'eq',
          first,
          fieldConfig.type,
          fieldConfig.prismaField,
          fieldConfig.valueMultiplier,
        );
        if (condition !== null) whereConditions.push(condition);
      } else {
        const orConditions = values
          .map((v) =>
            buildOperatorCondition('eq', v, fieldConfig.type, fieldConfig.prismaField, fieldConfig.valueMultiplier),
          )
          .filter((c): c is Record<string, unknown> => c !== null);
        if (orConditions.length > 0) whereConditions.push({ OR: orConditions });
      }
    }

    for (const { field, operator, value } of otherFilters) {
      const fieldConfig = config.advancedFilterFields[field]!;
      // Optional to-one `neq`: negate the positive match (NOT EXISTS) so a missing
      // row is kept. Skip to-many (`some`/`every`/`none`): `NOT some(eq)` ≠ `some(neq)`.
      if (
        operator === 'neq' &&
        fieldConfig.optionalRelation &&
        !/\.(some|every|none)(\.|$)/.test(fieldConfig.prismaField)
      ) {
        const positive = buildOperatorCondition(
          'eq',
          value,
          fieldConfig.type,
          fieldConfig.prismaField,
          fieldConfig.valueMultiplier,
        );
        if (positive === null) continue;
        whereConditions.push({ NOT: positive });
        continue;
      }
      const condition = buildOperatorCondition(
        operator,
        value,
        fieldConfig.type,
        fieldConfig.prismaField,
        fieldConfig.valueMultiplier,
      );
      if (condition === null) continue;
      whereConditions.push(condition);
    }
  }

  const where: Record<string, unknown> = whereConditions.length > 0 ? { AND: whereConditions } : {};

  return {
    where,
    orderBy,
    skip: (page - 1) * pageSize,
    take: pageSize,
  };
}

export function buildPaginatedResponse<T>(
  data: T[],
  totalItems: number,
  query: PaginationQuery,
  defaultPageSize?: number,
): PaginatedResult<T> {
  const page = query.page ?? 1;
  const pageSize = resolvePageSize(query.pageSize, defaultPageSize);

  return {
    data,
    meta: {
      page,
      pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / pageSize),
    },
  };
}

function deepMergeWhere(base: Record<string, unknown>, pagination: Record<string, unknown>): Record<string, unknown> {
  const result = { ...base };

  const andConditions: unknown[] = [];

  if (result.AND) {
    if (Array.isArray(result.AND)) {
      andConditions.push(...result.AND);
    } else {
      andConditions.push(result.AND);
    }
    delete result.AND;
  }

  if (pagination.AND) {
    if (Array.isArray(pagination.AND)) {
      andConditions.push(...pagination.AND);
    } else {
      andConditions.push(pagination.AND);
    }
  }

  for (const [key, value] of Object.entries(pagination)) {
    if (key !== 'AND') {
      result[key] = value;
    }
  }

  if (andConditions.length > 0) {
    result.AND = andConditions;
  }

  return result;
}

export async function paginateQuery<T>(
  delegate: {
    findMany(args: Record<string, unknown>): Promise<unknown[]>;
    count(args: Record<string, unknown>): Promise<number>;
  },
  query: PaginationQuery,
  config: PaginationConfig,
  baseFindManyArgs?: { where?: Record<string, unknown>; [key: string]: unknown },
): Promise<PaginatedResult<T>> {
  const { where: paginationWhere, orderBy, skip, take } = buildPaginationArgs(query, config);

  const mergedWhere = deepMergeWhere(baseFindManyArgs?.where ?? {}, paginationWhere);

  const findManyArgs = {
    ...baseFindManyArgs,
    where: mergedWhere,
    orderBy,
    skip,
    take,
  };

  const countArgs = { where: mergedWhere };

  const [rows, totalItems] = await Promise.all([delegate.findMany(findManyArgs), delegate.count(countArgs)]);

  return buildPaginatedResponse(rows as T[], totalItems, query, config.defaultPageSize);
}
