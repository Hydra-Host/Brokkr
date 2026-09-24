import type { JobLogEntry, JobSolLogsResponse } from '@repo/api-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { diagnosticsWrapper, fakeDiagnosticsApi } from '../../test/diagnostics-harness';
import { OPEN_JOB_POLL_MS } from '../poll-intervals';
import { LOG_TAIL_DRAIN_PAGE_CAP, LOG_TAIL_PAGE_LIMIT } from '../use-paged-log-tail';
import { SOL_TAIL_GRACE_MS, useSolLogTail } from '../use-sol-log-tail';

const solLogsPage =
  vi.fn<(deviceId: string, jobId: string, cursor: number, limit: number) => Promise<JobSolLogsResponse>>();

function page(indexes: number[], nextCursor: number | null, complete = false): JobSolLogsResponse {
  return {
    entries: indexes.map((index) => ({ index, timestamp: '2026-08-01T10:00:00', message: `line ${index}` })),
    nextCursor,
    complete,
  };
}

function renderTail(inFlight: boolean) {
  return renderHook(({ flag }: { flag: boolean }) => useSolLogTail('device-1', 'job-1', flag), {
    wrapper: diagnosticsWrapper(fakeDiagnosticsApi({ solLogsPage })),
    initialProps: { flag: inFlight },
  });
}

function requestedCursors(): number[] {
  return solLogsPage.mock.calls.map(([, , cursor]) => cursor);
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
  solLogsPage.mockReset();
});

describe('useSolLogTail', () => {
  it('drains full pages at once while in flight and then follows the tip', async () => {
    solLogsPage.mockResolvedValueOnce(page([0, 1], 500)).mockResolvedValueOnce(page([500], null));
    const { result } = renderTail(true);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0', '1', '500']));
    expect(requestedCursors()).toEqual([0, 500]);
    expect(solLogsPage.mock.calls[0]).toEqual(['device-1', 'job-1', 0, LOG_TAIL_PAGE_LIMIT]);
    expect(result.current.entries[0]).toEqual({
      id: '0',
      timestamp: '2026-08-01T10:00:00',
      logLevel: 'info',
      message: 'line 0',
      appName: 'bridge-api',
      appClassName: '',
    });
    expect(result.current.hasMore).toBe(false);
    expect(result.current.complete).toBe(false);
    expect(result.current.isTailing).toBe(true);
  });

  it('continues after a short page from the index after its last row', async () => {
    solLogsPage.mockResolvedValueOnce(page([0, 1], null)).mockResolvedValueOnce(page([2], null));
    const { result } = renderTail(true);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0', '1']));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0', '1', '2']));

    solLogsPage.mockResolvedValue(page([], null));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(solLogsPage).toHaveBeenCalledTimes(3));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(solLogsPage).toHaveBeenCalledTimes(4));
    expect(requestedCursors()).toEqual([0, 2, 3, 3]);
    expect(result.current.isTailing).toBe(true);
  });

  it('keeps polling a finished job whose rows grew within the grace until the capture completes', async () => {
    solLogsPage.mockResolvedValueOnce(page([0], null));
    const { result } = renderTail(false);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0']));

    solLogsPage.mockResolvedValue(page([], null));
    await elapse(SOL_TAIL_GRACE_MS - OPEN_JOB_POLL_MS * 2);
    expect(result.current.isTailing).toBe(true);

    solLogsPage.mockResolvedValue(page([1], null));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0', '1']));
    const callsAtGrowth = solLogsPage.mock.calls.length;
    await elapse(OPEN_JOB_POLL_MS * 3);
    expect(solLogsPage.mock.calls.length).toBeGreaterThan(callsAtGrowth);
    expect(result.current.isTailing).toBe(true);

    solLogsPage.mockResolvedValue(page([], null, true));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.isTailing).toBe(false);
    const callsAtComplete = solLogsPage.mock.calls.length;
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(solLogsPage).toHaveBeenCalledTimes(callsAtComplete);
  });

  it('stops a finished job after the grace passes without growth', async () => {
    solLogsPage.mockResolvedValueOnce(page([0], null));
    const { result } = renderTail(false);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0']));
    expect(result.current.isTailing).toBe(true);

    solLogsPage.mockResolvedValue(page([], null));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(solLogsPage).toHaveBeenCalledTimes(2));

    await elapse(SOL_TAIL_GRACE_MS + OPEN_JOB_POLL_MS);
    expect(result.current.isTailing).toBe(false);
    const callsAfterGrace = solLogsPage.mock.calls.length;
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(solLogsPage).toHaveBeenCalledTimes(callsAfterGrace);
    expect(result.current.complete).toBe(false);
  });

  it('stops an in-flight job once the capture is complete', async () => {
    solLogsPage.mockResolvedValue(page([0], null, true));
    const { result } = renderTail(true);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0']));
    expect(result.current.complete).toBe(true);
    expect(result.current.isTailing).toBe(false);
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(solLogsPage).toHaveBeenCalledTimes(1);
  });

  it('dedupes rows whose indexes overlap between tip pages', async () => {
    solLogsPage.mockResolvedValueOnce(page([0, 1], null)).mockResolvedValueOnce(page([1, 2], null));
    const { result } = renderTail(true);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0', '1']));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0', '1', '2']));
    expect(requestedCursors()).toEqual([0, 2]);
  });

  it('reports a forbidden capture without tailing', async () => {
    solLogsPage.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const { result } = renderTail(true);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isForbidden).toBe(true);
    expect(result.current.isTailing).toBe(false);
    expect(result.current.entries).toEqual([]);
    expect(result.current.complete).toBe(false);
  });

  it('stops an in-flight drain at the page cap and leaves the rest on load more', async () => {
    solLogsPage.mockImplementation(async (_deviceId, _jobId, cursor) => page([cursor], cursor + 1));
    const { result } = renderTail(true);
    await waitFor(() => expect(result.current.entries).toHaveLength(LOG_TAIL_DRAIN_PAGE_CAP));
    expect(solLogsPage).toHaveBeenCalledTimes(LOG_TAIL_DRAIN_PAGE_CAP);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isTailing).toBe(false);
    await elapse(OPEN_JOB_POLL_MS);
    expect(solLogsPage).toHaveBeenCalledTimes(LOG_TAIL_DRAIN_PAGE_CAP);
  });
});
