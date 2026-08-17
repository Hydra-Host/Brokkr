import { useInput } from 'ink';
import { useCallback, useEffect, useState } from 'react';
import type { PaginationMeta } from '../ui/table.js';

export function useBackQuitKeys(onBack?: () => void): void {
  useInput((input, key) => {
    if ((key.escape || key.backspace) && onBack) onBack();
    else if (input === 'q') process.exit(0);
  });
}

interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: null, loading: true, error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });

    fn()
      .then((data) => {
        if (!cancelled) setState({ data, loading: false, error: null });
      })
      .catch((err: Error) => {
        if (!cancelled) setState({ data: null, loading: false, error: err.message });
      });

    return () => {
      cancelled = true;
    };
  }, deps);

  return state;
}

interface PaginatedResult<T> {
  data: T[];
  meta: PaginationMeta;
}

interface PaginatedState<T> {
  result: PaginatedResult<T> | null;
  loading: boolean;
  error: string | null;
  page: number;
  nextPage: (() => void) | undefined;
  prevPage: (() => void) | undefined;
  pageInfo: string | undefined;
}

export function usePaginatedAsync<T>(
  fetcher: (query: { page: number; pageSize: number }) => Promise<PaginatedResult<T>>,
  pageSize = 20,
): PaginatedState<T> {
  const clampedPageSize = Math.min(pageSize, 100);
  const [page, setPage] = useState(1);
  const { data, loading, error } = useAsync(
    () => fetcher({ page, pageSize: clampedPageSize }),
    [page, clampedPageSize],
  );

  const meta = data?.meta;
  const hasNext = meta ? meta.page < meta.totalPages : false;
  const hasPrev = page > 1;

  const nextPage = useCallback(() => setPage((p) => p + 1), []);
  const prevPage = useCallback(() => setPage((p) => Math.max(1, p - 1)), []);

  const pageInfo = meta
    ? meta.totalPages > 1
      ? `Page ${meta.page}/${meta.totalPages} (${meta.totalItems} total)`
      : `${meta.totalItems} total`
    : undefined;

  return {
    result: data,
    loading,
    error,
    page,
    nextPage: hasNext ? nextPage : undefined,
    prevPage: hasPrev ? prevPage : undefined,
    pageInfo,
  };
}
