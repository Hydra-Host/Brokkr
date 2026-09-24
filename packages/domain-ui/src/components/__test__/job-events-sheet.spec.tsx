import type { LifecycleJobEvent, LifecycleJobEventsResponse, LifecycleJobSummary } from '@repo/api-client';
import { cleanup, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DiagnosticsApi } from '../../hooks/use-diagnostics-api';
import { fakeDiagnosticsApi, renderWithDiagnostics } from '../../test/diagnostics-harness';
import { JobEventsSheet } from '../job-events-sheet';
import { RECORDED_SAGAS_NOTE } from '../job-steps-pane';

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    to,
    search,
    className,
    children,
  }: {
    to: string;
    search?: Record<string, string>;
    className?: string;
    children: ReactNode;
  }) => (
    <a href={search ? `${to}?${new URLSearchParams(search).toString()}` : to} className={className}>
      {children}
    </a>
  ),
}));

vi.mock('@repo/ui/components/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const event = (over: Partial<LifecycleJobEvent> = {}): LifecycleJobEvent => ({
  id: 'e-1',
  sagaName: 'provision',
  stepName: 'set_boot_order',
  operation: null,
  eventType: 'job_completed',
  status: 'complete',
  result: null,
  error: null,
  attempt: 0,
  occurredAt: '2026-09-16T12:00:00.000Z',
  recordedAt: '2026-09-16T12:00:00.000Z',
  origin: 'bridge',
  ...over,
});

const job = (over: Partial<LifecycleJobSummary> = {}): LifecycleJobSummary => ({
  id: 'job-1',
  jobType: 'Provision',
  phase: 'RUNNING',
  deviceId: 'device-1',
  deploymentId: null,
  source: 'UI',
  performedBy: 'user-1',
  error: null,
  createdAt: '2026-09-16T11:59:00.000Z',
  completedAt: null,
  ...over,
});

const page = (data: LifecycleJobEvent[]): LifecycleJobEventsResponse => ({
  data,
  meta: { truncated: false, cap: 500 },
});

const fakeApi = (jobEvents: DiagnosticsApi['jobEvents']): DiagnosticsApi =>
  fakeDiagnosticsApi({
    jobEvents,
    jobLogsPage: async () => ({ entries: [], nextCursor: null }),
    hrefs: {
      ...fakeDiagnosticsApi().hrefs,
      jobs: (deviceId, jobId) => `/servers/${deviceId}/jobs?job=${jobId}`,
    },
  });

afterEach(cleanup);

describe('JobEventsSheet', () => {
  it('renders the job steps through the context api and links back to the server jobs page', async () => {
    const jobEvents = vi.fn(async () =>
      page([
        event({ id: 'a', stepName: 'power_cycle', attempt: 1, status: 'failed' }),
        event({ id: 'b', stepName: 'power_cycle', attempt: 2 }),
      ]),
    );
    renderWithDiagnostics(<JobEventsSheet job={job()} onClose={() => {}} />, fakeApi(jobEvents));

    expect(await screen.findByText('The bridge retried power_cycle 2 times.')).toBeInTheDocument();
    expect(jobEvents).toHaveBeenCalledWith('job-1');
    expect(screen.getByText('Job details')).toBeInTheDocument();
    expect(screen.getByText('Open in server jobs').getAttribute('href')).toBe('/servers/device-1/jobs?job=job-1');
  });

  it('hides the server jobs link for a job without a device', async () => {
    renderWithDiagnostics(
      <JobEventsSheet job={job({ deviceId: null })} onClose={() => {}} />,
      fakeApi(async () => page([])),
    );

    expect(await screen.findByText(/No step events were recorded for this job/)).toBeInTheDocument();
    expect(screen.queryByText('Open in server jobs')).not.toBeInTheDocument();
  });

  it('renders nothing while no job is open', () => {
    renderWithDiagnostics(<JobEventsSheet job={null} onClose={() => {}} />, fakeApi(vi.fn()));

    expect(screen.queryByText(RECORDED_SAGAS_NOTE)).not.toBeInTheDocument();
  });
});
