// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DatastoreSearch } from '@/lib/datastore-search';

import { FILTER_COMMIT_MS, useFilterParam, useSelectDatastoreTab, useSetDatastoreSearch } from './url-state';

type NavigateArgs = { search: (prev: DatastoreSearch) => DatastoreSearch; replace: boolean };

const EMPTY: DatastoreSearch = {
  tab: 'pg',
  schema: undefined,
  table: undefined,
  page: undefined,
  tableFilter: undefined,
  key: undefined,
  match: undefined,
  metric: undefined,
  metricFilter: undefined,
  queuePrefix: undefined,
  queueName: undefined,
  queueFilter: undefined,
  jobState: undefined,
  jobId: undefined,
  deviceId: undefined,
};

let search: DatastoreSearch = EMPTY;
const navigate = vi.fn<(args: NavigateArgs) => void>();

vi.mock('@tanstack/react-router', () => ({
  useSearch: () => search,
  useNavigate: () => navigate,
}));

function lastNavigate(): NavigateArgs {
  const args = navigate.mock.calls.at(-1);
  if (!args) throw new Error('navigate was not called');
  return args[0];
}

function patched(): DatastoreSearch {
  return lastNavigate().search(search);
}

beforeEach(() => {
  vi.useFakeTimers();
  search = EMPTY;
  navigate.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useSetDatastoreSearch', () => {
  it('replaces history for a within-view write', () => {
    const { result } = renderHook(() => useSetDatastoreSearch());
    act(() => result.current({ schema: 'public', table: 'Device' }));
    expect(lastNavigate().replace).toBe(true);
    expect(patched()).toMatchObject({ schema: 'public', table: 'Device' });
  });

  it('merges the patch over the current search rather than replacing it', () => {
    search = { ...EMPTY, tab: 'redis', match: '*:device:*' };
    const { result } = renderHook(() => useSetDatastoreSearch());
    act(() => result.current({ key: 'zone:1' }));
    expect(patched()).toMatchObject({ tab: 'redis', match: '*:device:*', key: 'zone:1' });
  });

  it('pushes history only when the caller opts in', () => {
    const { result } = renderHook(() => useSetDatastoreSearch());
    act(() => result.current({ tab: 'thanos' }, { push: true }));
    expect(lastNavigate().replace).toBe(false);
  });
});

describe('useSelectDatastoreTab', () => {
  it('pushes a history entry when the tab changes', () => {
    const { result } = renderHook(() => useSelectDatastoreTab());
    act(() => result.current('thanos'));
    expect(lastNavigate().replace).toBe(false);
    expect(patched().tab).toBe('thanos');
  });

  it('does not stack a history entry when the active tab is re-selected', () => {
    search = { ...EMPTY, tab: 'thanos' };
    const { result } = renderHook(() => useSelectDatastoreTab());
    act(() => result.current('thanos'));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(lastNavigate().replace).toBe(true);
  });

  it('ignores a tab id outside the union', () => {
    const { result } = renderHook(() => useSelectDatastoreTab());
    act(() => result.current('sagas'));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('pushes a history entry for the queues tab', () => {
    const { result } = renderHook(() => useSelectDatastoreTab());
    act(() => result.current('queues'));
    expect(lastNavigate().replace).toBe(false);
    expect(patched().tab).toBe('queues');
  });
});

describe('useFilterParam', () => {
  it('commits a settled draft to the url after the debounce', () => {
    const { result } = renderHook(() => useFilterParam('tableFilter'));
    act(() => result.current.setFilter('dev'));
    expect(navigate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(patched().tableFilter).toBe('dev');
  });

  it('commits with replace so typing never stacks history entries', () => {
    const { result } = renderHook(() => useFilterParam('tableFilter'));
    act(() => result.current.setFilter('dev'));
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS));
    expect(lastNavigate().replace).toBe(true);
  });

  it('never commits a draft superseded inside the debounce window', () => {
    const { result } = renderHook(() => useFilterParam('tableFilter'));
    act(() => result.current.setFilter('d'));
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS - 100));
    act(() => result.current.setFilter('de'));
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS - 100));
    expect(navigate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(100));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(patched().tableFilter).toBe('de');
  });

  it('never commits a draft abandoned inside the debounce window', () => {
    const { result, unmount } = renderHook(() => useFilterParam('tableFilter'));
    act(() => result.current.setFilter('dev'));
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS - 1));
    unmount();
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS * 4));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('drops the key from the url when the box is emptied', () => {
    search = { ...EMPTY, tableFilter: 'dev' };
    const { result } = renderHook(() => useFilterParam('tableFilter'));
    expect(result.current.filter).toBe('dev');
    act(() => result.current.setFilter(''));
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS));
    expect(patched().tableFilter).toBeUndefined();
  });

  it('does not re-commit when the committed value re-enters through the url', () => {
    const { result, rerender } = renderHook(() => useFilterParam('tableFilter'));
    act(() => result.current.setFilter('dev'));
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS));
    expect(navigate).toHaveBeenCalledTimes(1);
    search = { ...EMPTY, tableFilter: 'dev' };
    rerender();
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS * 4));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('adopts a filter value that arrives from outside the box', () => {
    search = { ...EMPTY, tableFilter: undefined };
    const { result, rerender } = renderHook(() => useFilterParam('tableFilter'));
    expect(result.current.filter).toBe('');

    search = { ...EMPTY, tableFilter: 'device' };
    rerender();
    expect(result.current.filter).toBe('device');

    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS * 2));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('keeps keystrokes typed while its own commit was in flight', () => {
    search = { ...EMPTY, tableFilter: undefined };
    const { result, rerender } = renderHook(() => useFilterParam('tableFilter'));

    act(() => result.current.setFilter('dev'));
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS));
    expect(patched().tableFilter).toBe('dev');

    act(() => result.current.setFilter('devi'));
    search = { ...EMPTY, tableFilter: 'dev' };
    rerender();

    expect(result.current.filter).toBe('devi');
  });

  it('writes the metric filter to its own key', () => {
    const { result } = renderHook(() => useFilterParam('metricFilter'));
    act(() => result.current.setFilter('node'));
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS));
    expect(patched().metricFilter).toBe('node');
    expect(patched().tableFilter).toBeUndefined();
  });

  it('writes the queue filter to its own key', () => {
    const { result } = renderHook(() => useFilterParam('queueFilter'));
    act(() => result.current.setFilter('inbox'));
    act(() => vi.advanceTimersByTime(FILTER_COMMIT_MS));
    expect(patched().queueFilter).toBe('inbox');
    expect(patched().tableFilter).toBeUndefined();
    expect(patched().metricFilter).toBeUndefined();
  });
});
