import type { JobLogEntry } from '@repo/api-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { diagnosticsWrapper } from '../../test/diagnostics-harness';
import { OPEN_JOB_POLL_MS } from '../poll-intervals';
import { usePagedLogTail, type TailPage } from '../use-paged-log-tail';

const GRACE_MS = OPEN_JOB_POLL_MS * 5;

const fetchPage = vi.fn<(cursor: number, limit: number) => Promise<TailPage<number>>>();

function entry(index: number): JobLogEntry {
  return {
    id: String(index),
    timestamp: '2026-08-01T10:00:00.000Z',
    logLevel: 'info',
    message: `line ${index}`,
    appName: 'bridge-api',
    appClassName: '',
  };
}

function page(indexes: number[], nextCursor: number | null, complete = false): TailPage<number> {
  const last = indexes.at(-1);
  return {
    entries: indexes.map(entry),
    nextCursor,
    tipCursor: last === undefined ? undefined : last + 1,
    complete,
  };
}

function renderTail(inFlight: boolean, graceMs?: number) {
  return renderHook(
    ({ flag }: { flag: boolean }) =>
      usePagedLogTail<number>({ queryKey: ['paged-tail', 'job-1'], initialCursor: 0, fetchPage, inFlight: flag, graceMs }),
    { wrapper: diagnosticsWrapper(), initialProps: { flag: inFlight } },
  );
}

function requestedCursors(): number[] {
  return fetchPage.mock.calls.map(([cursor]) => cursor);
}

function ids(entries: JobLogEntry[]): string[] {
  return entries.map((item) => item.id);
}

async function elapse(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  fetchPage.mockReset();
});

describe('usePagedLogTail', () => {
  it('resumes the tip from the page cursor after a short page and keeps it when the page is empty', async () => {
    fetchPage.mockResolvedValueOnce(page([0, 1], null)).mockResolvedValueOnce(page([2], null));
    const { result } = renderTail(true);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0', '1']));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0', '1', '2']));

    fetchPage.mockResolvedValue(page([], null));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(3));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(4));
    expect(requestedCursors()).toEqual([0, 2, 3, 3]);
    expect(result.current.isTailing).toBe(true);
  });

  it('keeps following a finished job whose rows grew within the grace until the capture completes', async () => {
    fetchPage.mockResolvedValueOnce(page([0], null));
    const { result } = renderTail(false, GRACE_MS);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0']));

    fetchPage.mockResolvedValue(page([], null));
    await elapse(GRACE_MS - OPEN_JOB_POLL_MS * 2);
    expect(result.current.isTailing).toBe(true);

    fetchPage.mockResolvedValue(page([1], null));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0', '1']));
    const callsAtGrowth = fetchPage.mock.calls.length;
    await elapse(OPEN_JOB_POLL_MS * 3);
    expect(fetchPage.mock.calls.length).toBeGreaterThan(callsAtGrowth);
    expect(result.current.isTailing).toBe(true);

    fetchPage.mockResolvedValue(page([], null, true));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.isTailing).toBe(false);
    const callsAtComplete = fetchPage.mock.calls.length;
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(fetchPage).toHaveBeenCalledTimes(callsAtComplete);
  });

  it('stops a finished job after the grace passes without growth', async () => {
    fetchPage.mockResolvedValueOnce(page([0], null));
    const { result } = renderTail(false, GRACE_MS);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0']));
    expect(result.current.isTailing).toBe(true);

    fetchPage.mockResolvedValue(page([], null));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));

    await elapse(GRACE_MS + OPEN_JOB_POLL_MS);
    expect(result.current.isTailing).toBe(false);
    const callsAfterGrace = fetchPage.mock.calls.length;
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(fetchPage).toHaveBeenCalledTimes(callsAfterGrace);
    expect(result.current.complete).toBe(false);
  });

  it('stops an in-flight job once the capture is complete', async () => {
    fetchPage.mockResolvedValue(page([0], null, true));
    const { result } = renderTail(true);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0']));
    expect(result.current.complete).toBe(true);
    expect(result.current.isTailing).toBe(false);
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('does not follow a finished job without a grace window', async () => {
    fetchPage.mockResolvedValue(page([0], null));
    const { result } = renderTail(false);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0']));
    expect(result.current.isTailing).toBe(false);
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });
});
