import type { LifecycleJobEvent, LifecycleJobSummary, PaginatedResponse } from '@repo/api-client';
import { OPEN_JOB_POLL_MS } from '@repo/domain-ui/hooks/poll-intervals';
import { DiagnosticsApiProvider, type DiagnosticsApi } from '@repo/domain-ui/hooks/use-diagnostics-api';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@repo/ui/components/select', () => ({
  Select: (props: { value?: string; onValueChange?: (value: string) => void; children?: ReactNode }) => (
    <select value={props.value} onChange={(event) => props.onValueChange?.(event.target.value)}>
      {props.children}
    </select>
  ),
  SelectContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children?: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

import { DeploymentProgressCard } from '../deployment-progress-card';

const NEWER_ID = '22222222-2222-4222-8222-222222222222';
const OLDER_ID = '11111111-1111-4111-8111-111111111111';

const listJobs = vi.fn<DiagnosticsApi['listJobs']>();
const jobEvents = vi.fn<DiagnosticsApi['jobEvents']>();
const unused = () => Promise.reject(new Error('unused'));

function api(overrides: Partial<DiagnosticsApi> = {}): DiagnosticsApi {
  return {
    bootTrail: unused,
    bootReadiness: unused,
    healthSummary: unused,
    listHealthChecks: unused,
    requestHealthCheck: unused,
    listDeviceTokens: unused,
    listJobs,
    jobEvents,
    jobLogsPage: unused,
    solLogsPage: unused,
    gates: { isLoading: false, can: () => true },
    hrefs: {
      jobs: (deviceId) => `/servers/${deviceId}/jobs`,
      diagnostics: (deviceId) => `/servers/${deviceId}/diagnostics`,
      health: (deviceId) => `/servers/${deviceId}/health`,
      prefix: () => null,
      zone: () => null,
      zoneCommission: () => null,
    },
    ...overrides,
  };
}

function summary(id: string, over: Partial<LifecycleJobSummary> = {}): LifecycleJobSummary {
  return {
    id,
    jobType: 'Provision',
    phase: 'COMPLETED',
    deviceId: 'dev-1',
    deploymentId: 'dep-1',
    source: 'UI',
    performedBy: null,
    error: null,
    createdAt: '2026-09-18T15:25:28.000Z',
    completedAt: '2026-09-18T15:31:02.000Z',
    ...over,
  };
}

function page(rows: LifecycleJobSummary[]): PaginatedResponse<LifecycleJobSummary> {
  return { data: rows, meta: { page: 1, pageSize: 20, totalItems: rows.length, totalPages: 1 } };
}

function event(stepName: string): LifecycleJobEvent {
  return {
    id: `e-${stepName}`,
    sagaName: 'provision',
    stepName,
    operation: null,
    eventType: 'step_completed',
    status: 'complete',
    result: null,
    error: null,
    attempt: 0,
    occurredAt: '2026-09-18T15:25:31.000Z',
    recordedAt: '2026-09-18T15:25:31.000Z',
    origin: 'bridge',
  };
}

function renderCard(overrides: Partial<DiagnosticsApi> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DiagnosticsApiProvider api={api(overrides)}>
        <DeploymentProgressCard deploymentId="dep-1" />
      </DiagnosticsApiProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  listJobs.mockReset();
  jobEvents.mockReset();
});

describe('DeploymentProgressCard', () => {
  it('selects the newest job and shows its steps without any log pane', async () => {
    listJobs.mockResolvedValue(page([summary(NEWER_ID), summary(OLDER_ID)]));
    jobEvents.mockResolvedValue({ data: [event('power_off')], meta: { truncated: false, cap: 500 } });
    renderCard();

    expect(await screen.findByText('power_off')).toBeInTheDocument();
    expect(listJobs).toHaveBeenCalledWith({ deploymentId: 'dep-1' }, { page: 1, pageSize: 20 });
    expect(jobEvents).toHaveBeenCalledWith(NEWER_ID);
    expect(screen.getByRole('combobox')).toHaveValue(NEWER_ID);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByRole('log', { hidden: true })).not.toBeInTheDocument();
  });

  it('switches the detail to the chosen job', async () => {
    listJobs.mockResolvedValue(page([summary(NEWER_ID), summary(OLDER_ID)]));
    jobEvents.mockResolvedValue({ data: [event('power_off')], meta: { truncated: false, cap: 500 } });
    renderCard();
    await screen.findByText('power_off');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: OLDER_ID } });

    await waitFor(() => expect(jobEvents).toHaveBeenCalledWith(OLDER_ID));
    expect(screen.getByRole('combobox')).toHaveValue(OLDER_ID);
  });

  it('hides the job select when a single job ran', async () => {
    listJobs.mockResolvedValue(page([summary(NEWER_ID)]));
    jobEvents.mockResolvedValue({ data: [event('power_off')], meta: { truncated: false, cap: 500 } });
    renderCard();

    await screen.findByText('power_off');
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('says when no job has run yet', async () => {
    listJobs.mockResolvedValue(page([]));
    renderCard();

    expect(await screen.findByText('No lifecycle job has run for this deployment yet.')).toBeInTheDocument();
    expect(jobEvents).not.toHaveBeenCalled();
  });

  it('says when the list cannot be loaded', async () => {
    listJobs.mockRejectedValue(new Error('boom'));
    renderCard();

    expect(await screen.findByText('The lifecycle jobs could not be loaded.')).toBeInTheDocument();
  });

  it('waits for the gates before listing any job', () => {
    renderCard({ gates: { isLoading: true, can: () => false } });

    expect(listJobs).not.toHaveBeenCalled();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('polls the list while a job is in flight and stops once every job has finished', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    listJobs.mockResolvedValue(page([summary(NEWER_ID, { phase: 'RUNNING', completedAt: null })]));
    jobEvents.mockResolvedValue({ data: [], meta: { truncated: false, cap: 500 } });
    renderCard();
    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(1));

    listJobs.mockResolvedValue(page([summary(NEWER_ID)]));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPEN_JOB_POLL_MS);
    });
    await waitFor(() => expect(listJobs).toHaveBeenCalledTimes(2));
    await screen.findByText('COMPLETED');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(OPEN_JOB_POLL_MS * 2);
    });
    expect(listJobs).toHaveBeenCalledTimes(2);
  });
});
