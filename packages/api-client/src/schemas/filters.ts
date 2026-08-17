export const FilterOperator = {
  eq: 'eq',
  neq: 'neq',
  gt: 'gt',
  gte: 'gte',
  lt: 'lt',
  lte: 'lte',
  contains: 'contains',
} as const;

export type FilterOperator = (typeof FilterOperator)[keyof typeof FilterOperator];

export const FilterFieldType = {
  string: 'string',
  number: 'number',
  enum: 'enum',
  date: 'date',
} as const;

export type FilterFieldType = (typeof FilterFieldType)[keyof typeof FilterFieldType];

export const OPERATORS_BY_TYPE: Record<FilterFieldType, FilterOperator[]> = {
  string: ['eq', 'neq', 'contains'],
  number: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
  enum: ['eq', 'neq'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'],
};

export const OPERATOR_LABELS: Record<FilterOperator, string> = {
  eq: 'equals',
  neq: 'not equals',
  gt: 'greater than',
  gte: 'greater or equal',
  lt: 'less than',
  lte: 'less or equal',
  contains: 'contains',
};
