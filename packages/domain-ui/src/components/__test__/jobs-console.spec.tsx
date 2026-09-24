import type { DeviceJob, LifecycleJobSummary, PaginatedResponse } from '@repo/api-client';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiagnosticsApi } from '../../hooks/use-diagnostics-api';
import type { ServerColumnDef } from '../../hooks/use-server-table';
import { fakeDiagnosticsApi, renderWithDiagnostics } from '../../test/diagnostics-harness';
import { JobsConsole, type JobsConsoleProps } from '../jobs-console';

vi.mock('../../hooks/use-job-log-tail', () => ({
  useJobLogTail: () => ({
    entries: [],
    isPending: false,
    isError: false,
    error: undefined,
    isForbidden: false,
    hasMore: false,
    isFetchingMore: false,
    loadMore: () => undefined,
    isTailing: false,
    complete: false,
  }),
}));

vi.mock('../../hooks/use-sol-log-tail', () => ({
  useSolLogTail: () => ({
    entries: [],
    isPending: false,
    isError: false,
    error: undefined,
    isForbidden: false,
    hasMore: false,
    isFetchingMore: false,
    loadMore: () => undefined,
    isTailing: false,
    complete: false,
  }),
}));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/', search: {}, searchStr: '' }),
  Link: ({ children }: { children?: ReactNode }) => <a>{children}</a>,
}));

vi.mock('@repo/ui/components/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
  SelectValue: () => null,
}));

const OLDER_ID = 'job-older-0001';
const NEWER_ID = 'job-newer-0002';

const listJobs = vi.fn<DiagnosticsApi['listJobs']>();
const listDeviceJobs = vi.fn<NonNullable<DiagnosticsApi['listDeviceJobs']>>();
const jobEvents = vi.fn<DiagnosticsApi['jobEvents']>();
const gates = { history: true, logs: true };

function api(overrides: Partial<DiagnosticsApi> = {}): DiagnosticsApi {
  return fakeDiagnosticsApi({
    listJobs,
    listDeviceJobs,
    jobEvents,
    gates: {
      isLoading: false,
      can: (gate) => (gate === 'jobs.view' ? gates.history : gate === 'job-logs.access' ? gates.logs : true),
    },
    ...overrides,
  });
}

function summary(over: Partial<LifecycleJobSummary> = {}): LifecycleJobSummary {
  return {
    id: OLDER_ID,
    jobType: 'Provision',
    phase: 'COMPLETED',
    deviceId: 'dev-1',
    deploymentId: null,
    source: 'UI',
    performedBy: null,
    error: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    completedAt: '2026-09-01T10:05:00.000Z',
    ...over,
  };
}

const lifecycleRows = [
  summary(),
  summary({ id: NEWER_ID, phase: 'RUNNING', createdAt: '2026-09-02T10:00:00.000Z', completedAt: null }),
];

const deviceJobs: DeviceJob[] = [
  { id: OLDER_ID, jobType: 'Provision', status: 'Completed', createdAt: '2026-09-01T10:00:00.000Z', error: null },
  { id: NEWER_ID, jobType: 'Reboot', status: 'RUNNING', createdAt: '2026-09-02T10:00:00.000Z', error: null },
];

function pageOf(rows: LifecycleJobSummary[]): PaginatedResponse<LifecycleJobSummary> {
  return { data: rows, meta: { page: 1, pageSize: 20, totalItems: rows.length, totalPages: 1 } };
}

function renderConsole(props: Partial<JobsConsoleProps> = {}, diagnostics: DiagnosticsApi = api()) {
  const onSelectJob = vi.fn();
  const view = renderWithDiagnostics(
    <JobsConsole deviceId="dev-1" onSelectJob={onSelectJob} {...props} />,
    diagnostics,
  );
  return { ...view, onSelectJob };
}

async function rowOf(shortId: string): Promise<HTMLElement> {
  const row = (await screen.findByText(shortId)).closest('tr');
  if (!row) throw new Error(`no table row for ${shortId}`);
  return row;
}

beforeEach(() => {
  gates.history = true;
  gates.logs = true;
  jobEvents.mockResolvedValue({ data: [], meta: { truncated: false, cap: 500 } });
});

afterEach(() => {
  cleanup();
  listJobs.mockReset();
  listDeviceJobs.mockReset();
  jobEvents.mockReset();
});

describe('JobsConsole for a job history reader', () => {
  it('selects the newest job by default and highlights its row', async () => {
    listJobs.mockResolvedValue(pageOf(lifecycleRows));
    renderConsole();
    expect(await screen.findByText(NEWER_ID)).toBeInTheDocument();
    expect(screen.queryByText(OLDER_ID)).not.toBeInTheDocument();
    await waitFor(async () => expect(await rowOf('job-newe')).toHaveAttribute('data-state', 'selected'));
    expect(await rowOf('job-olde')).not.toHaveAttribute('data-state', 'selected');
    expect(listJobs).toHaveBeenCalledWith({ deviceId: 'dev-1' }, expect.objectContaining({ page: 1 }));
  });

  it('lets the requested job win over the newest one', async () => {
    listJobs.mockResolvedValue(pageOf(lifecycleRows));
    renderConsole({ requestedJobId: OLDER_ID });
    expect(await screen.findByText(OLDER_ID)).toBeInTheDocument();
    await waitFor(async () => expect(await rowOf('job-olde')).toHaveAttribute('data-state', 'selected'));
  });

  it('shows a requested job outside the loaded page by id alone', async () => {
    listJobs.mockResolvedValue(pageOf(lifecycleRows));
    renderConsole({ requestedJobId: 'job-elsewhere' });
    expect(await screen.findByText('job-elsewhere')).toBeInTheDocument();
    expect(screen.queryByText(/^Requested .+/)).not.toBeInTheDocument();
  });

  it('reports a row click through onSelectJob', async () => {
    listJobs.mockResolvedValue(pageOf(lifecycleRows));
    const { onSelectJob } = renderConsole();
    fireEvent.click(await screen.findByText('job-olde'));
    expect(onSelectJob).toHaveBeenCalledWith(OLDER_ID);
  });

  it('renders the given columns and the footer for the selected job', async () => {
    listJobs.mockResolvedValue(pageOf(lifecycleRows));
    const columns: ServerColumnDef<LifecycleJobSummary>[] = [
      { id: 'source', accessorKey: 'source', header: 'Source', cell: ({ row }) => <span>via {row.original.source}</span> },
    ];
    renderConsole({ columns, footer: (job) => <span>footer for {job.id}</span> });
    expect(await screen.findByText(`footer for ${NEWER_ID}`)).toBeInTheDocument();
    expect(screen.getByText('Source')).toBeInTheDocument();
    expect(screen.getAllByText('via UI')).toHaveLength(2);
    expect(screen.queryByText('Kind')).not.toBeInTheDocument();
  });

  it('shows the steps and the log access message without the job log gate', async () => {
    gates.logs = false;
    listJobs.mockResolvedValue(pageOf(lifecycleRows));
    renderConsole();
    expect(await screen.findByText(/No step events were recorded for this job\./)).toBeInTheDocument();
    expect(screen.getByText('You do not have access to job logs.')).toBeInTheDocument();
    expect(listDeviceJobs).not.toHaveBeenCalled();
  });

  it('shows the empty message when no jobs were recorded', async () => {
    listJobs.mockResolvedValue(pageOf([]));
    renderConsole();
    expect((await screen.findAllByText(/No lifecycle jobs recorded\./)).length).toBeGreaterThan(0);
  });
});

describe('JobsConsole for a job log reader', () => {
  beforeEach(() => {
    gates.history = false;
  });

  it('lists device jobs, selects the newest and shows the steps access message', async () => {
    listDeviceJobs.mockResolvedValue(deviceJobs);
    renderConsole();
    expect(await screen.findByRole('button', { name: /job-newe/ })).toHaveAttribute('aria-current', 'true');
    expect(screen.getByRole('button', { name: /job-olde/ })).not.toHaveAttribute('aria-current');
    expect(screen.getByText(NEWER_ID)).toBeInTheDocument();
    expect(screen.getByText('You do not have access to job events.')).toBeInTheDocument();
    expect(listDeviceJobs).toHaveBeenCalledWith('dev-1');
    expect(listJobs).not.toHaveBeenCalled();
  });

  it('reports a picker click through onSelectJob', async () => {
    listDeviceJobs.mockResolvedValue(deviceJobs);
    const { onSelectJob } = renderConsole();
    fireEvent.click(await screen.findByRole('button', { name: /job-olde/ }));
    expect(onSelectJob).toHaveBeenCalledWith(OLDER_ID);
  });

  it('shows the empty message when the device has no jobs', async () => {
    listDeviceJobs.mockResolvedValue([]);
    renderConsole();
    expect((await screen.findAllByText('No jobs recorded for this device.')).length).toBeGreaterThan(0);
  });

  it('shows the access message when the server forbids the job list', async () => {
    listDeviceJobs.mockRejectedValue(Object.assign(new Error('forbidden'), { status: 403 }));
    renderConsole();
    expect(await screen.findByText('You do not have access to job logs.')).toBeInTheDocument();
  });

  it('renders nothing when the api has no device job list', () => {
    const { container } = renderConsole({}, api({ listDeviceJobs: undefined }));
    expect(container).toBeEmptyDOMElement();
    expect(listJobs).not.toHaveBeenCalled();
  });
});

describe('JobsConsole without either gate', () => {
  it('renders nothing', () => {
    gates.history = false;
    gates.logs = false;
    const { container } = renderConsole();
    expect(container).toBeEmptyDOMElement();
    expect(listJobs).not.toHaveBeenCalled();
    expect(listDeviceJobs).not.toHaveBeenCalled();
  });
});
