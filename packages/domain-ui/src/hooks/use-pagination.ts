import { useLocation, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';

import type { PaginationQuery } from '@repo/api-client';
import type { SortingState } from '@tanstack/react-table';

const DEFAULT_PAGE_SIZE = 20;

interface UsePaginationOptions {
  defaultPageSize?: number;
  sortFieldMap?: Record<string, string>;
}

function parseSearchFromLocation(search: Record<string, unknown>, defaultPageSize: number) {
  return {
    page: Number(search.page) || 1,
    pageSize: Number(search.pageSize) || defaultPageSize,
    search: typeof search.search === 'string' ? search.search : '',
    sort: typeof search.sort === 'string' ? search.sort : undefined,
  };
}

function sortStringToState(sort: string | undefined, fieldToColumnMap: Record<string, string>): SortingState {
  if (!sort) return [];
  const [field, dir] = sort.split(':');
  if (!field) return [];
  const columnId = fieldToColumnMap[field] ?? field;
  return [{ id: columnId, desc: dir === 'desc' }];
}

function stateToSortString(state: SortingState, columnToFieldMap: Record<string, string>): string | undefined {
  if (state.length === 0) return undefined;
  const { id, desc } = state[0];
  const field = columnToFieldMap[id] ?? id;
  return `${field}:${desc ? 'desc' : 'asc'}`;
}

function invertMap(map: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(map)) {
    result[v] = k;
  }
  return result;
}

type NavigateWithSearch = (opts: {
  search: (prev: Record<string, unknown>) => Record<string, unknown>;
  replace?: boolean;
}) => Promise<void> | void;

export function usePagination({ defaultPageSize = DEFAULT_PAGE_SIZE, sortFieldMap = {} }: UsePaginationOptions = {}) {
  const navigateWithSearch = useNavigate() as NavigateWithSearch;
  const location = useLocation();

  const fieldToColumnMap = invertMap(sortFieldMap);
  const url = parseSearchFromLocation(location.search as Record<string, unknown>, defaultPageSize);

  const [searchInput, setSearchInput] = useState(url.search);

  const prevUrlSearch = useRef(url.search);
  if (url.search !== prevUrlSearch.current) {
    prevUrlSearch.current = url.search;
    if (url.search !== searchInput) {
      setSearchInput(url.search);
    }
  }

  const urlSearchRef = useRef(url.search);
  urlSearchRef.current = url.search;

  const updateSearch = (updater: (prev: Record<string, unknown>) => Record<string, unknown>) => {
    void navigateWithSearch({ search: updater, replace: true });
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== urlSearchRef.current) {
        updateSearch((prev) => ({
          ...prev,
          search: searchInput || undefined,
          page: undefined,
        }));
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const setPage = (newPage: number) => {
    updateSearch((prev) => ({
      ...prev,
      page: newPage > 1 ? newPage : undefined,
    }));
  };

  const setPageSize = (newSize: number) => {
    updateSearch((prev) => ({
      ...prev,
      pageSize: newSize !== defaultPageSize ? newSize : undefined,
      page: undefined,
    }));
  };

  const sorting = sortStringToState(url.sort, fieldToColumnMap);

  const onSortingChange = (state: SortingState) => {
    const sortStr = stateToSortString(state, sortFieldMap);
    updateSearch((prev) => ({
      ...prev,
      sort: sortStr,
      page: undefined,
    }));
  };

  const query: PaginationQuery = {
    page: url.page,
    pageSize: url.pageSize,
    search: url.search?.trim() || undefined,
    sort: url.sort,
  };

  return {
    page: url.page,
    setPage,
    pageSize: url.pageSize,
    setPageSize,
    search: searchInput,
    setSearch: setSearchInput,
    sorting,
    onSortingChange,
    query,
    updateSearch,
  };
}
