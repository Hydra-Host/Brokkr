import { useLocation, useNavigate } from '@tanstack/react-router';
import { useCallback, useMemo } from 'react';

export type FilterOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains';
export type FilterFieldType = 'string' | 'number' | 'enum' | 'date';

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

export const OPERATOR_SYMBOLS: Record<FilterOperator, string> = {
  eq: '=',
  neq: '\u2260',
  gt: '>',
  gte: '\u2265',
  lt: '<',
  lte: '\u2264',
  contains: '~',
};

export interface FilterFieldConfig {
  field: string;
  label: string;
  type: FilterFieldType;
  options?: string[];
}

export interface ActiveFilter {
  id: string;
  field: string;
  operator: FilterOperator;
  value: string;
}

interface UseFiltersOptions {
  fields: FilterFieldConfig[];
}

function parseFiltersParam(param: string | null): ActiveFilter[] {
  if (!param) return [];
  return param
    .split('|')
    .map((tuple) => {
      const parts = tuple.split(':');
      if (parts.length < 3) return null;
      const [field, operator, ...rest] = parts;
      const value = rest.join(':');
      if (!field || !operator || !value) return null;
      return {
        id: `${field}-${operator}-${value}`,
        field,
        operator: operator as FilterOperator,
        value,
      };
    })
    .filter((f): f is ActiveFilter => f !== null);
}

function serializeFilters(filters: ActiveFilter[]): string | undefined {
  if (filters.length === 0) return undefined;
  return filters.map((f) => `${f.field}:${f.operator}:${f.value}`).join('|');
}

export function useFilters({ fields }: UseFiltersOptions) {
  void fields;
  const navigate = useNavigate();
  const location = useLocation();

  const activeFilters = useMemo(() => {
    const params = new URLSearchParams(location.searchStr);
    return parseFiltersParam(params.get('filters'));
  }, [location.searchStr]);

  const updateUrl = useCallback(
    (newFilters: ActiveFilter[]) => {
      void (navigate as (opts: any) => void)({
        search: (prev: Record<string, unknown>) => ({
          ...prev,
          filters: serializeFilters(newFilters),
          page: undefined,
        }),
        replace: true,
      });
    },
    [navigate],
  );

  const addFilter = useCallback(
    (field: string, operator: FilterOperator, value: string) => {
      const newFilter: ActiveFilter = {
        id: `${field}-${operator}-${value}`,
        field,
        operator,
        value,
      };
      updateUrl([...activeFilters, newFilter]);
    },
    [activeFilters, updateUrl],
  );

  const removeFilter = useCallback(
    (id: string) => {
      updateUrl(activeFilters.filter((f) => f.id !== id));
    },
    [activeFilters, updateUrl],
  );

  const clearFilters = useCallback(() => {
    updateUrl([]);
  }, [updateUrl]);

  const filtersQueryParam = useMemo(() => serializeFilters(activeFilters), [activeFilters]);

  return {
    activeFilters,
    addFilter,
    removeFilter,
    clearFilters,
    filtersQueryParam,
  };
}
