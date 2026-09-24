import type { JobLogEntry } from '@repo/api-client';
import { screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiagnosticsApi } from '../../hooks/use-diagnostics-api';
import type { JobLogTail } from '../../hooks/use-job-log-tail';
import type { SolLogTail } from '../../hooks/use-sol-log-tail';
import { fakeDiagnosticsApi, renderWithDiagnostics } from '../../test/diagnostics-harness';

const { useJobLogTail, useSolLogTail, gates } = vi.hoisted(() => ({
  useJobLogTail: vi.fn(),
  useSolLogTail: vi.fn(),
  gates: { logs: true },
}));

vi.mock('../../hooks/use-job-log-tail', () => ({ useJobLogTail }));
vi.mock('../../hooks/use-sol-log-tail', () => ({ useSolLogTail }));

vi.mock('@repo/ui/components/select', () => ({
  Select: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
}));

import { JobDetail, SERIAL_CONSOLE_UNAVAILABLE_MESSAGE, type JobRef } from '../job-detail';
import { NO_JOB_LOG_ACCESS_MESSAGE } from '../job-log-viewer';

const jobEvents = vi.fn<DiagnosticsApi['jobEvents']>();

const job: JobRef = {
  id: 'job-1',
  jobType: 'Provision',
  phase: 'RUNNING',
  createdAt: '2026-09-01T10:00:00.000Z',
  completedAt: null,
  error: null,
  inFlight: true,
};

function entry(id: string, message: string): JobLogEntry {
  return { id, timestamp: '2026-09-01T10:00:00.000Z', logLevel: 'info', message, appName: 'bridge-api', appClassName: '' };
}

function jobLogTail(): JobLogTail {
  return {
    entries: [entry('e1', 'provision started')],
    isPending: false,
    isError: false,
    error: undefined,
    isForbidden: false,
    hasMore: false,
    isFetchingMore: false,
    loadMore: vi.fn(),
    isTailing: true,
    complete: false,
  };
}

function solLogTail(): SolLogTail {
  return { ...jobLogTail(), entries: [entry('0', 'iPXE 1.21.1')] };
}

function api(): DiagnosticsApi {
  return fakeDiagnosticsApi({
    jobEvents,
    gates: { isLoading: false, can: (gate) => gate !== 'job-logs.access' || gates.logs },
  });
}

function renderDetail(deviceId: string | null) {
  return renderWithDiagnostics(<JobDetail key={job.id} jobId={job.id} deviceId={deviceId} job={job} />, api());
}

beforeEach(() => {
  vi.clearAllMocks();
  gates.logs = true;
  jobEvents.mockResolvedValue({ data: [], meta: { truncated: false, cap: 500 } });
  useJobLogTail.mockReturnValue(jobLogTail());
  useSolLogTail.mockReturnValue(solLogTail());
});

describe('JobDetail', () => {
  it('offers job log and serial console tabs and keeps both streams mounted', () => {
    renderDetail('dev-1');
    expect(screen.getByRole('tab', { name: 'Job log' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Serial console' })).toBeInTheDocument();
    expect(screen.getByRole('log', { name: 'Job log output' })).toBeInTheDocument();
    expect(screen.queryByRole('log', { name: 'Serial console output' })).not.toBeInTheDocument();
    expect(screen.getByRole('log', { name: 'Serial console output', hidden: true })).toBeInTheDocument();
    expect(useJobLogTail).toHaveBeenCalledWith('job-1', true);
    expect(useSolLogTail).toHaveBeenCalledWith('dev-1', 'job-1', true);
  });

  it('explains the missing serial console for a job without a device and never tails it', () => {
    renderDetail(null);
    expect(screen.getByRole('tab', { name: 'Serial console' })).toBeInTheDocument();
    expect(screen.getByText(SERIAL_CONSOLE_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(useSolLogTail).not.toHaveBeenCalled();
  });

  it('shows the access message once and no tabs without the job log permission', () => {
    gates.logs = false;
    renderDetail('dev-1');
    expect(screen.getAllByText(NO_JOB_LOG_ACCESS_MESSAGE)).toHaveLength(1);
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(useJobLogTail).not.toHaveBeenCalled();
    expect(useSolLogTail).not.toHaveBeenCalled();
  });

  it('renders only the steps when logs are turned off, even with the job log permission', () => {
    renderWithDiagnostics(<JobDetail jobId="job-1" deviceId={null} logs={false} />, api());
    expect(screen.getByRole('heading', { name: 'Steps' })).toBeInTheDocument();
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.queryByText(NO_JOB_LOG_ACCESS_MESSAGE)).not.toBeInTheDocument();
    expect(screen.queryByRole('log', { hidden: true })).not.toBeInTheDocument();
    expect(useJobLogTail).not.toHaveBeenCalled();
    expect(useSolLogTail).not.toHaveBeenCalled();
  });
});
