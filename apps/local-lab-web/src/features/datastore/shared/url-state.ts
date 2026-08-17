import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';

import { type DatastoreSearch, isDatastoreTab } from '@/lib/datastore-search';

export const FILTER_COMMIT_MS = 300;

type FilterKey = 'tableFilter' | 'metricFilter' | 'queueFilter';

export function useDatastoreSearch() {
  return useSearch({ from: '/datastore' });
}

export function useSetDatastoreSearch() {
  const navigate = useNavigate({ from: '/datastore' });
  return useCallback(
    (patch: Partial<DatastoreSearch>, opts?: { push?: boolean }) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: !opts?.push });
    },
    [navigate],
  );
}

// a tab change is the only within-route write worth a back-button stop; re-selecting the active tab is not
export function useSelectDatastoreTab() {
  const { tab } = useDatastoreSearch();
  const setSearch = useSetDatastoreSearch();
  return useCallback(
    (id: string) => {
      if (isDatastoreTab(id)) setSearch({ tab: id }, { push: id !== tab });
    },
    [tab, setSearch],
  );
}

function filterPatch(key: FilterKey, value: string | undefined): Partial<DatastoreSearch> {
  if (key === 'tableFilter') return { tableFilter: value };
  if (key === 'metricFilter') return { metricFilter: value };
  return { queueFilter: value };
}

// adopting only values this box did not send is what lets an external url change land while the echo of
// our own commit cannot clobber keystrokes typed since it was scheduled
export function useParamDraft(committed: string) {
  const [draft, setDraft] = useState(committed);
  const sentRef = useRef(committed);

  useEffect(() => {
    if (committed === sentRef.current) return;
    sentRef.current = committed;
    setDraft(committed);
  }, [committed]);

  const markSent = useCallback((value: string) => {
    sentRef.current = value;
  }, []);

  return { draft, setDraft, markSent };
}

// the box stays local so keystrokes never wait on a navigation; the url only records where typing settled
export function useDebouncedParam(committed: string, commit: (value: string | undefined) => void) {
  const { draft: filter, setDraft: setFilter, markSent } = useParamDraft(committed);

  useEffect(() => {
    if (filter === committed) return;
    const timer = setTimeout(() => {
      markSent(filter);
      commit(filter || undefined);
    }, FILTER_COMMIT_MS);
    return () => clearTimeout(timer);
  }, [filter, committed, commit, markSent]);

  return { filter, setFilter };
}

export function useFilterParam(key: FilterKey) {
  const committed = useDatastoreSearch()[key] ?? '';
  const setSearch = useSetDatastoreSearch();
  const commit = useCallback((value: string | undefined) => setSearch(filterPatch(key, value)), [key, setSearch]);
  return useDebouncedParam(committed, commit);
}
