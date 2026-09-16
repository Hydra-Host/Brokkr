import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { useJobLogsQuery } = vi.hoisted(() => ({ useJobLogsQuery: vi.fn() }));

vi.mock('~/lib/api', () => ({
  tsr: { getJobLogs: { useQuery: useJobLogsQuery } },
}));

vi.mock('@repo/ui/components/select', () => ({
  Select: (props: { value?: string; onValueChange?: (value: string) => void; children?: ReactNode }) => (
    <select
      data-testid="level-select"
      value={props.value}
      onChange={(event) => props.onValueChange?.(event.target.value)}
    >
      {['all', 'debug', 'info', 'warning', 'error'].map((value) => (
        <option key={value} value={value}>
          {value}
        </option>
      ))}
    </select>
  ),
  SelectContent: () => null,
  SelectItem: () => null,
  SelectTrigger: () => null,
}));

import { JobLogViewer } from '../job-log-viewer';

const entries = [
  {
    id: 'e1',
    timestamp: '2026-08-01T10:00:00.000Z',
    logLevel: 'INFO',
    message: 'provision started',
    appName: 'bridge',
    appClassName: 'ProvisionSaga',
  },
  {
    id: 'e2',
    timestamp: '2026-08-01T10:01:00.000Z',
    logLevel: 'ERROR',
    message: 'ipmi power on failed',
    appName: 'bridge',
    appClassName: 'PowerOps',
  },
];

function mockPage(page: { entries: typeof entries; nextCursor: string | null }) {
  useJobLogsQuery.mockReturnValue({
    data: { status: 200, body: page },
    isPending: false,
    isFetching: false,
    isError: false,
  });
}

function renderViewer() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <JobLogViewer key="job-1" jobId="job-1" />
    </QueryClientProvider>,
  );
}

function viewerFor(client: QueryClient, jobId: string) {
  return (
    <QueryClientProvider client={client}>
      <JobLogViewer key={jobId} jobId={jobId} />
    </QueryClientProvider>
  );
}

function latestRequestedCursor(): unknown {
  const call: unknown = useJobLogsQuery.mock.calls.at(-1)?.[0];
  if (typeof call !== 'object' || call === null || !('queryData' in call)) return undefined;
  const { queryData } = call;
  if (typeof queryData !== 'object' || queryData === null || !('query' in queryData)) return undefined;
  const { query } = queryData;
  if (typeof query !== 'object' || query === null || !('cursor' in query)) return undefined;
  return query.cursor;
}

describe('JobLogViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a row per log entry', () => {
    mockPage({ entries, nextCursor: null });
    renderViewer();
    expect(screen.getByText('provision started')).toBeInTheDocument();
    expect(screen.getByText('ipmi power on failed')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(within(screen.getByRole('table')).getByText('info')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('error')).toBeInTheDocument();
  });

  it('hides rows that do not match the level filter', () => {
    mockPage({ entries, nextCursor: null });
    renderViewer();
    fireEvent.change(screen.getByTestId('level-select'), { target: { value: 'error' } });
    expect(screen.getByText('ipmi power on failed')).toBeInTheDocument();
    expect(screen.queryByText('provision started')).not.toBeInTheDocument();
  });

  it('filters rows by message substring case-insensitively', () => {
    mockPage({ entries, nextCursor: null });
    renderViewer();
    fireEvent.change(screen.getByPlaceholderText('Search messages'), { target: { value: 'IPMI' } });
    expect(screen.getByText('ipmi power on failed')).toBeInTheDocument();
    expect(screen.queryByText('provision started')).not.toBeInTheDocument();
  });

  it('shows the empty state when the job has no entries', () => {
    mockPage({ entries: [], nextCursor: null });
    renderViewer();
    expect(screen.getByText('No log entries for this job.')).toBeInTheDocument();
  });

  it('shows the filter empty state when filters match nothing', () => {
    mockPage({ entries, nextCursor: null });
    renderViewer();
    fireEvent.change(screen.getByPlaceholderText('Search messages'), { target: { value: 'no such message' } });
    expect(screen.getByText('No entries match the current filters.')).toBeInTheDocument();
  });

  it('shows the load more button while a next cursor exists', () => {
    mockPage({ entries, nextCursor: 'cursor-2' });
    renderViewer();
    expect(screen.getByText('Load more')).toBeInTheDocument();
  });

  it('hides the load more button when the next cursor is null', () => {
    mockPage({ entries, nextCursor: null });
    renderViewer();
    expect(screen.queryByText('Load more')).not.toBeInTheDocument();
  });

  it('requests the next page when load more is clicked', () => {
    mockPage({ entries, nextCursor: 'cursor-2' });
    renderViewer();
    fireEvent.click(screen.getByText('Load more'));
    expect(latestRequestedCursor()).toBe('cursor-2');
  });

  it('requests the first page again after switching jobs and back', () => {
    mockPage({ entries, nextCursor: 'cursor-2' });
    const client = new QueryClient();
    const view = render(viewerFor(client, 'job-1'));
    fireEvent.click(screen.getByText('Load more'));
    expect(latestRequestedCursor()).toBe('cursor-2');
    view.rerender(viewerFor(client, 'job-2'));
    view.rerender(viewerFor(client, 'job-1'));
    expect(latestRequestedCursor()).toBeUndefined();
  });

  it('shows the error state when the query fails', () => {
    useJobLogsQuery.mockReturnValue({ data: undefined, isPending: false, isFetching: false, isError: true });
    renderViewer();
    expect(screen.getByText('Failed to load job logs.')).toBeInTheDocument();
  });
});
