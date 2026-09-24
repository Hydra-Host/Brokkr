import type { ExportLogsJobType, JobLogEntry, SolLogsResponse } from '@repo/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface GetLogsArgs {
  params: { id: string };
  body: { jobType: ExportLogsJobType };
}

type GetLogsResult = { status: 200; body: SolLogsResponse } | { status: 403 | 404; body: { message: string } };

const { getLogs } = vi.hoisted(() => ({
  getLogs: vi.fn<(args: GetLogsArgs) => Promise<GetLogsResult>>(),
}));

vi.mock('~/lib/api', () => ({ tsr: { getLogs: { mutate: getLogs } } }));

import { OPEN_JOB_POLL_MS } from '@repo/domain-ui/hooks/poll-intervals';
import { SOL_TAIL_GRACE_MS } from '@repo/domain-ui/hooks/use-sol-log-tail';
import { useDeploymentSolLog } from '../use-deployment-sol-log';

function response(lineCount: number, complete = false): GetLogsResult {
  return {
    status: 200,
    body: {
      success: true,
      message: '',
      complete,
      entries: Array.from({ length: lineCount }, (_, index) => ({
        timestamp: '2026-08-01T10:00:00',
        message: `line ${index}`,
      })),
    },
  };
}

function renderLog(jobType: ExportLogsJobType = 'Provision') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client }, children);
  return renderHook(({ type }: { type: ExportLogsJobType }) => useDeploymentSolLog('dep-1', type), {
    wrapper,
    initialProps: { type: jobType },
  });
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
  getLogs.mockReset();
});

describe('useDeploymentSolLog', () => {
  it('reads the whole list and polls while the capture is incomplete and growing', async () => {
    getLogs.mockResolvedValueOnce(response(1)).mockResolvedValueOnce(response(2));
    const { result } = renderLog();
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0']));
    expect(getLogs).toHaveBeenCalledWith({ params: { id: 'dep-1' }, body: { jobType: 'Provision' } });
    expect(result.current.entries[0]).toEqual({
      id: '0',
      timestamp: '2026-08-01T10:00:00',
      logLevel: 'info',
      message: 'line 0',
      appName: 'bridge-api',
      appClassName: '',
    });
    expect(result.current.isTailing).toBe(true);
    expect(result.current.hasMore).toBe(false);

    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0', '1']));
    expect(result.current.isTailing).toBe(true);
    expect(result.current.complete).toBe(false);
  });

  it('stops polling once the capture is complete', async () => {
    getLogs.mockResolvedValue(response(1, true));
    const { result } = renderLog();
    await waitFor(() => expect(result.current.complete).toBe(true));
    expect(result.current.isTailing).toBe(false);
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(getLogs).toHaveBeenCalledTimes(1);
  });

  it('stops polling after the grace passes without growth', async () => {
    getLogs.mockResolvedValue(response(1));
    const { result } = renderLog();
    await waitFor(() => expect(ids(result.current.entries)).toEqual(['0']));
    expect(result.current.isTailing).toBe(true);

    await elapse(OPEN_JOB_POLL_MS);
    await waitFor(() => expect(getLogs).toHaveBeenCalledTimes(2));

    await elapse(SOL_TAIL_GRACE_MS + OPEN_JOB_POLL_MS);
    expect(result.current.isTailing).toBe(false);
    const callsAfterGrace = getLogs.mock.calls.length;
    await elapse(OPEN_JOB_POLL_MS * 2);
    expect(getLogs).toHaveBeenCalledTimes(callsAfterGrace);
    expect(result.current.complete).toBe(false);
  });

  it('reports a forbidden log without tailing', async () => {
    getLogs.mockResolvedValue({ status: 403, body: { message: 'Forbidden' } });
    const { result } = renderLog();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.isForbidden).toBe(true);
    expect(result.current.isTailing).toBe(false);
    expect(result.current.entries).toEqual([]);
  });
});
