import type { LifecycleJobSummary, PaginatedResponse } from '@repo/api-client';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OPEN_JOB_POLL_MS } from '../../hooks/poll-intervals';
import type { DiagnosticsApi } from '../../hooks/use-diagnostics-api';
import { diagnosticsWrapper, fakeDiagnosticsApi } from '../../test/diagnostics-harness';
import { useLifecycleJobs } from '../job-history-columns';

const listJobs = vi.fn<DiagnosticsApi['listJobs']>();
const table = { query: { page: 1, pageSize: 20 } };
const scope = { deploymentId: 'dep-1' };

const summary: LifecycleJobSummary = {
  id: 'job-1',
  jobType: 'Provision',
  phase: 'RUNNING',
  deviceId: 'dev-1',
  deploymentId: 'dep-1',
  source: 'UI',
  performedBy: null,
  error: null,
  createdAt: '2026-09-18T15:25:28.000Z',
  completedAt: null,
};

const page: PaginatedResponse<LifecycleJobSummary> = {
  data: [summary],
  meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  listJobs.mockReset();
});

describe('useLifecycleJobs', () => {
  it('lists the jobs once and leaves the list alone without a poll interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listJobs.mockResolvedValue(page);
    const { result } = renderHook(() => useLifecycleJobs(table, scope), {
      wrapper: diagnosticsWrapper(fakeDiagnosticsApi({ listJobs })),
    });

    await waitFor(() => expect(result.current.rows).toEqual([summary]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPEN_JOB_POLL_MS);
    });

    expect(listJobs).toHaveBeenCalledTimes(1);
    expect(listJobs).toHaveBeenCalledWith(scope, table.query);
  });

  it('refetches the list at the requested poll interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listJobs.mockResolvedValue(page);
    const { result } = renderHook(() => useLifecycleJobs(table, scope, { refetchInterval: OPEN_JOB_POLL_MS }), {
      wrapper: diagnosticsWrapper(fakeDiagnosticsApi({ listJobs })),
    });

    await waitFor(() => expect(result.current.rows).toEqual([summary]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPEN_JOB_POLL_MS);
    });

    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(2));
  });
});
