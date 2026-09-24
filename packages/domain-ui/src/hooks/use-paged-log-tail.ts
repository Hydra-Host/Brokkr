import type { JobLogEntry } from '@repo/api-client';
import { useQuery, type QueryKey } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { isForbiddenError } from './api-errors';
import { OPEN_JOB_POLL_MS } from './poll-intervals';

export const LOG_TAIL_PAGE_LIMIT = 500;
// a stream is trimmed to ~10000 entries, so this many full pages is the whole retained log
export const LOG_TAIL_DRAIN_PAGE_CAP = 20;

export interface TailPage<Cursor> {
  entries: JobLogEntry[];
  nextCursor: Cursor | null;
  /** Where the tip poll resumes after a short page; left unset, the cursor stays where it was. */
  tipCursor?: Cursor;
  complete?: boolean;
}

export interface PagedLogTailOptions<Cursor> {
  queryKey: QueryKey;
  initialCursor: Cursor;
  fetchPage: (cursor: Cursor, limit: number) => Promise<TailPage<Cursor>>;
  inFlight: boolean;
  /** Keep following a finished job while its rows grew within this window. */
  graceMs?: number;
  pageLimit?: number;
  drainPageCap?: number;
}

export interface PagedLogTail {
  entries: JobLogEntry[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isForbidden: boolean;
  hasMore: boolean;
  isFetchingMore: boolean;
  loadMore: () => void;
  isTailing: boolean;
  complete: boolean;
}

interface TailSnapshot {
  entries: JobLogEntry[];
  hasMore: boolean;
  complete: boolean;
}

const NO_ENTRIES: JobLogEntry[] = [];

// the cursor and held entries live in this instance, so consumers must remount when the stream changes
export function usePagedLogTail<Cursor>({
  queryKey,
  initialCursor,
  fetchPage,
  inFlight,
  graceMs,
  pageLimit = LOG_TAIL_PAGE_LIMIT,
  drainPageCap = LOG_TAIL_DRAIN_PAGE_CAP,
}: PagedLogTailOptions<Cursor>): PagedLogTail {
  const cursorRef = useRef(initialCursor);
  const heldRef = useRef<JobLogEntry[]>(NO_ENTRIES);
  const seenRef = useRef(new Set<string>());
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const lastGrowthAtRef = useRef(Date.now());
  const inFlightRef = useRef(inFlight);
  inFlightRef.current = inFlight;

  async function pullPages(signal: AbortSignal): Promise<TailSnapshot> {
    const pageCap = inFlightRef.current ? drainPageCap : 1;
    let hasMore = false;
    let complete = false;
    for (let page = 0; page < pageCap && !signal.aborted; page++) {
      const result = await fetchPage(cursorRef.current, pageLimit);
      complete = result.complete ?? false;
      const fresh = result.entries.filter((entry) => !seenRef.current.has(entry.id));
      for (const entry of fresh) seenRef.current.add(entry.id);
      if (fresh.length > 0) {
        heldRef.current = [...heldRef.current, ...fresh];
        lastGrowthAtRef.current = Date.now();
      }
      hasMore = result.nextCursor !== null;
      if (result.nextCursor !== null) {
        cursorRef.current = result.nextCursor;
        continue;
      }
      if (result.tipCursor !== undefined) cursorRef.current = result.tipCursor;
      break;
    }
    return { entries: heldRef.current, hasMore, complete };
  }

  // a stream still growing keeps the tail alive after the job ends; a silent one stops after the grace
  function shouldTail(errored: boolean, snapshot: TailSnapshot | undefined): boolean {
    if (errored || snapshot?.hasMore !== false || snapshot.complete) return false;
    return inFlight || (graceMs !== undefined && Date.now() - lastGrowthAtRef.current < graceMs);
  }

  const query = useQuery({
    queryKey,
    // cached pages from an earlier mount would not line up with this instance's cursor
    gcTime: 0,
    // an invalidation cancels the running pull; chaining keeps two pulls from interleaving their pages
    queryFn: ({ signal }) => {
      const run = chainRef.current.then(() => pullPages(signal));
      chainRef.current = run.catch(() => undefined);
      return run;
    },
    refetchInterval: (current) =>
      shouldTail(current.state.status === 'error', current.state.data) ? OPEN_JOB_POLL_MS : false,
  });

  const { refetch } = query;
  const wasInFlight = useRef(inFlight);
  useEffect(() => {
    // the bridge sink flushes after completion, so drain once more when the job turns terminal
    if (wasInFlight.current && !inFlight) void refetch();
    wasInFlight.current = inFlight;
  }, [inFlight, refetch]);

  const snapshot = query.data;

  return {
    entries: snapshot?.entries ?? NO_ENTRIES,
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    isForbidden: query.isError && isForbiddenError(query.error),
    hasMore: snapshot?.hasMore ?? false,
    isFetchingMore: query.isFetching && snapshot !== undefined,
    loadMore: () => {
      void refetch();
    },
    isTailing: shouldTail(query.isError, snapshot),
    complete: snapshot?.complete ?? false,
  };
}
