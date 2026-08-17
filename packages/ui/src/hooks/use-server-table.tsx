import { useMemo, useState } from 'react';

import type { ColumnDef, HeaderContext } from '@tanstack/react-table';
import type { FilterFieldConfig } from './use-filters';
import { useFilters } from './use-filters';
import { usePagination } from './use-pagination';
import { useResponsiveColumns } from './use-responsive-columns';

type Breakpoint = 'mobile' | 'tablet' | 'desktop';

export type ServerColumnDef<TData, TValue = unknown> = ColumnDef<TData, TValue> & {
  sortField?: string;
  breakpoint?: Breakpoint;
  noTruncate?: boolean;
};

interface UseServerTableOptions<TData> {
  name: string;
  columns: ServerColumnDef<TData>[];
  defaultPageSize?: number;
  filterFields?: FilterFieldConfig[];
}

function getColumnId<T>(col: ServerColumnDef<T>): string | undefined {
  if ('id' in col && col.id) return col.id;
  if ('accessorKey' in col && typeof col.accessorKey === 'string') return col.accessorKey;
  return undefined;
}

function getStorageKey(name: string) {
  return `table-prefs:${name}`;
}

function readExpandedFromStorage(name: string): boolean {
  try {
    const raw = localStorage.getItem(getStorageKey(name));
    if (raw !== null) return JSON.parse(raw) === true;
  } catch {
    return false;
  }
  return false;
}

export function useServerTable<TData>({ name, columns, defaultPageSize, filterFields }: UseServerTableOptions<TData>) {
  const [columnsExpanded, setColumnsExpanded] = useState(() => readExpandedFromStorage(name));

  const { sortFieldMap, breakpointConfig } = useMemo(() => {
    const sfm: Record<string, string> = {};
    const bpc: Record<string, Breakpoint> = {};
    for (const col of columns) {
      const id = getColumnId(col);
      if (!id) continue;
      if (col.sortField) sfm[id] = col.sortField;
      if (col.breakpoint) bpc[id] = col.breakpoint;
    }
    return { sortFieldMap: sfm, breakpointConfig: bpc };
  }, [columns]);

  const hasBreakpointColumns = Object.keys(breakpointConfig).length > 0;

  const pagination = usePagination({ defaultPageSize, sortFieldMap });
  const columnVisibility = useResponsiveColumns(breakpointConfig, columnsExpanded);
  const filters = useFilters({ fields: filterFields ?? [] });

  const processedColumns = useMemo(() => {
    return columns.map((col) => {
      const { sortField, breakpoint, ...colDef } = col;
      void breakpoint;

      if (sortField && typeof colDef.header === 'string') {
        const label = colDef.header;
        return {
          ...colDef,
          header: ({ column }: HeaderContext<TData, unknown>) => {
            const sorted = column.getIsSorted();
            return (
              <button
                type="button"
                className="hover:text-text-primary inline-flex cursor-pointer items-center gap-1 uppercase"
                onClick={() => column.toggleSorting(sorted === 'asc')}
              >
                <span>{label}</span>
                <span className="text-xs">{sorted === 'asc' ? '↑' : sorted === 'desc' ? '↓' : '↕'}</span>
              </button>
            );
          },
        };
      }

      return colDef;
    }) as ColumnDef<TData>[];
  }, [columns]);

  const query = filterFields ? { ...pagination.query, filters: filters.filtersQueryParam } : pagination.query;

  return {
    name,
    columns: processedColumns,
    columnVisibility,
    sorting: pagination.sorting,
    onSortingChange: pagination.onSortingChange,
    search: pagination.search,
    setSearch: pagination.setSearch,
    page: pagination.page,
    setPage: pagination.setPage,
    pageSize: pagination.pageSize,
    setPageSize: pagination.setPageSize,
    query,
    updateSearch: pagination.updateSearch,
    activeFilters: filters.activeFilters,
    addFilter: filters.addFilter,
    removeFilter: filters.removeFilter,
    clearFilters: filters.clearFilters,
    filterFields,
    columnsExpanded,
    toggleColumnsExpanded: () =>
      setColumnsExpanded((prev) => {
        const next = !prev;
        try {
          localStorage.setItem(getStorageKey(name), JSON.stringify(next));
        } catch (error) {
          console.info('Failed to persist table preferences', error);
        }
        return next;
      }),
    hasBreakpointColumns,
  };
}
