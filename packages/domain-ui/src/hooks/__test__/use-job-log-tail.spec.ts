import type { JobLogEntry, JobLogsResponse } from '@repo/api-client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { diagnosticsWrapper, fakeDiagnosticsApi } from '../../test/diagnostics-harness';
import { OPEN_JOB_POLL_MS } from '../poll-intervals';
import { useJobLogTail } from '../use-job-log-tail';
import { LOG_TAIL_DRAIN_PAGE_CAP, LOG_TAIL_PAGE_LIMIT } from '../use-paged-log-tail';

const jobLogsPage = vi.fn<(jobId: string, cursor: string | undefined, limit: number) => Promise<JobLogsResponse>>();

function entry(id: string): JobLogEntry {
  return {
    id,
    timestamp: '2026-08-01T10:00:00.000Z',
    logLevel: 'INFO',
    message: `line ${id}`,
    appName: 'bridge-api',
    appClassName: 'ProvisionSaga',
  };
}

function page(ids: string[], nextCursor: string | null): JobLogsResponse {
  return { entries: ids.map(entry), nextCursor };
}

function renderTail(inFlight: boolean) {
  return renderHook(({ flag }: { flag: boolean }) => useJobLogTail('job-1', flag), {
    wrapper: diagnosticsWrapper(fakeDiagnosticsApi({ jobLogsPage })),
    initialProps: { flag: inFlight },
  });
}

function requestedCursors(): (string | undefined)[] {
  return jobLogsPage.mock.calls.map(([, cursor]) => cursor);
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
  jobLogsPage.mockReset();
});

describe('useJobLogTail', () => {
  it('drains full pages at once while in flight and then follows the tip', async () => {
    jobLogsPage.mockResolvedValueOnce(page(['1', '2'], '2')).mockResolvedValueOnce(page(['3'], null));
    const { result } = renderTail(true);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['1', '2', '3']));
    expect(requestedCursors()).toEqual([undefined, '2']);
    expect(jobLogsPage.mock.calls[0]).toEqual(['job-1', undefined, LOG_TAIL_PAGE_LIMIT]);
    expect(result.current.hasMore).toBe(false);
    expect(result.current.isTailing).toBe(true);
    expect(result.current.complete).toBe(false);
  });

  it('leaves a finished job on load more after one full page', async () => {
    jobLogsPage.mockResolvedValueOnce(page(['1', '2'], '2'));
    const { result } = renderTail(false);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['1', '2']));
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isTailing).toBe(false);
    expect(jobLogsPage).toHaveBeenCalledTimes(1);

    jobLogsPage.mockResolvedValueOnce(page(['3'], null));
    act(() => result.current.loadMore());
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['1', '2', '3']));
    expect(requestedCursors()).toEqual([undefined, '2']);
    expect(result.current.hasMore).toBe(false);
  });

  it('polls the tip at the open job interval while in flight and caught up', async () => {
    jobLogsPage.mockResolvedValue(page(['1'], null));
    const { result } = renderTail(true);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['1']));

    jobLogsPage.mockResolvedValue(page([], null));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(jobLogsPage).toHaveBeenCalledTimes(2));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(jobLogsPage).toHaveBeenCalledTimes(3));
    expect(requestedCursors()).toEqual([undefined, '1', '1']);
    expect(result.current.isTailing).toBe(true);
  });

  it('does not poll a finished job', async () => {
    jobLogsPage.mockResolvedValue(page(['1'], null));
    const { result } = renderTail(false);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['1']));
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(jobLogsPage).toHaveBeenCalledTimes(1);
    expect(result.current.isTailing).toBe(false);
  });

  it('dedupes entries that overlap between tip pages', async () => {
    jobLogsPage.mockResolvedValueOnce(page(['1', '2'], null)).mockResolvedValueOnce(page(['2', '3'], null));
    const { result } = renderTail(true);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['1', '2']));
    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['1', '2', '3']));
    expect(requestedCursors()).toEqual([undefined, '2']);
  });

  it('reports a forbidden stream without tailing', async () => {
    jobLogsPage.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    const { result } = renderTail(true);
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isForbidden).toBe(true);
    expect(result.current.isTailing).toBe(false);
    expect(result.current.entries).toEqual([]);
  });

  it('stops an in-flight drain at the page cap and leaves the rest on load more', async () => {
    jobLogsPage.mockImplementation(async (_jobId, cursor) => {
      const from = Number(cursor ?? '0');
      return page([String(from + 1)], String(from + 1));
    });
    const { result } = renderTail(true);
    await waitFor(() => expect(result.current.entries).toHaveLength(LOG_TAIL_DRAIN_PAGE_CAP));
    expect(jobLogsPage).toHaveBeenCalledTimes(LOG_TAIL_DRAIN_PAGE_CAP);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isTailing).toBe(false);
    await elapse(OPEN_JOB_POLL_MS);
    expect(jobLogsPage).toHaveBeenCalledTimes(LOG_TAIL_DRAIN_PAGE_CAP);
  });

  it('drains once more when the job completes and then stops', async () => {
    jobLogsPage.mockResolvedValueOnce(page(['1'], null)).mockResolvedValueOnce(page(['2'], null));
    const { result, rerender } = renderTail(true);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['1']));

    rerender({ flag: false });
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['1', '2']));
    expect(requestedCursors()).toEqual([undefined, '1']);
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(jobLogsPage).toHaveBeenCalledTimes(2);
    expect(result.current.isTailing).toBe(false);
  });
});
