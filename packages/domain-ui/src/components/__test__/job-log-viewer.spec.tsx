import type { JobLogEntry } from '@repo/api-client';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { JobLogTail } from '../../hooks/use-job-log-tail';
import { fakeDiagnosticsApi, renderWithDiagnostics } from '../../test/diagnostics-harness';

const { useJobLogTail, access } = vi.hoisted(() => ({
  useJobLogTail: vi.fn(),
  access: { value: true, loading: false },
}));

vi.mock('../../hooks/use-job-log-tail', () => ({ useJobLogTail }));

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

const TIME_ONLY = /^\d{2}:\d{2}:\d{2}\.\d{3}$/;

const entries: JobLogEntry[] = [
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

function tail(over: Partial<JobLogTail> = {}): JobLogTail {
  return {
    entries: [],
    isPending: false,
    isError: false,
    error: undefined,
    isForbidden: false,
    hasMore: false,
    isFetchingMore: false,
    loadMore: vi.fn(),
    isTailing: false,
    complete: false,
    ...over,
  };
}

const api = () => fakeDiagnosticsApi({ gates: { isLoading: access.loading, can: () => access.value } });

function renderViewer(inFlight = false, fill = false) {
  return renderWithDiagnostics(<JobLogViewer key="job-1" jobId="job-1" inFlight={inFlight} fill={fill} />, api());
}

function scrollContainer(): HTMLElement {
  return screen.getByRole('log', { name: 'Job log output' });
}

function fakeScrollMetrics(element: HTMLElement, scrollTop: number) {
  Object.defineProperty(element, 'scrollHeight', { value: 1000, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: 200, configurable: true });
  Object.defineProperty(element, 'scrollTop', { value: scrollTop, writable: true, configurable: true });
}

afterEach(cleanup);

describe('JobLogViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    access.value = true;
    access.loading = false;
  });

  it('renders a compact row per log entry with a time-only stamp and a level badge', () => {
    useJobLogTail.mockReturnValue(tail({ entries }));
    renderViewer();
    const log = scrollContainer();
    expect(within(log).getByText('provision started')).toBeInTheDocument();
    expect(within(log).getByText('ipmi power on failed')).toBeInTheDocument();
    expect(within(log).getByText('info')).toBeInTheDocument();
    expect(within(log).getByText('error')).toBeInTheDocument();
    const times = within(log).getAllByText(TIME_ONLY);
    expect(times).toHaveLength(2);
    expect(times[0]).toHaveAttribute('datetime', '2026-08-01T10:00:00.000Z');
    expect(within(log).getByText('ProvisionSaga')).toBeInTheDocument();
    expect(useJobLogTail).toHaveBeenCalledWith('job-1', false);
  });

  it('shortens the warning level and hides an unknown app class', () => {
    useJobLogTail.mockReturnValue(
      tail({ entries: [{ ...entries[0], id: 'w1', logLevel: 'WARNING', appClassName: 'unknown' }] }),
    );
    renderViewer();
    expect(screen.getByText('warn')).toBeInTheDocument();
    expect(screen.queryByText('unknown')).not.toBeInTheDocument();
  });

  it('fills its container instead of capping the log height when asked', () => {
    useJobLogTail.mockReturnValue(tail({ entries }));
    renderViewer(false, true);
    expect(scrollContainer()).toHaveClass('h-full');
    expect(scrollContainer()).not.toHaveClass('max-h-[32rem]');
  });

  it('hides rows that do not match the level filter', () => {
    useJobLogTail.mockReturnValue(tail({ entries }));
    renderViewer();
    fireEvent.change(screen.getByTestId('level-select'), { target: { value: 'error' } });
    expect(screen.getByText('ipmi power on failed')).toBeInTheDocument();
    expect(screen.queryByText('provision started')).not.toBeInTheDocument();
  });

  it('filters rows by message substring case-insensitively', () => {
    useJobLogTail.mockReturnValue(tail({ entries }));
    renderViewer();
    fireEvent.change(screen.getByPlaceholderText('Search messages'), { target: { value: 'IPMI' } });
    expect(screen.getByText('ipmi power on failed')).toBeInTheDocument();
    expect(screen.queryByText('provision started')).not.toBeInTheDocument();
  });

  it('shows the filter empty state when filters match nothing', () => {
    useJobLogTail.mockReturnValue(tail({ entries }));
    renderViewer();
    fireEvent.change(screen.getByPlaceholderText('Search messages'), { target: { value: 'no such message' } });
    expect(screen.getByText('No entries match the current filters.')).toBeInTheDocument();
  });

  it('reads an empty stream on a finished job as no retained log', () => {
    useJobLogTail.mockReturnValue(tail());
    renderViewer(false);
    expect(screen.getByText('No log stream is retained for this job.')).toBeInTheDocument();
    expect(screen.queryByText('Following live output')).not.toBeInTheDocument();
  });

  it('waits for output on an in-flight job that has logged nothing yet', () => {
    useJobLogTail.mockReturnValue(tail({ isTailing: true }));
    renderViewer(true);
    expect(screen.getByText('Waiting for log output.')).toBeInTheDocument();
    expect(screen.getByText('Following live output')).toBeInTheDocument();
    expect(useJobLogTail).toHaveBeenCalledWith('job-1', true);
  });

  it('shows the load more button while more pages remain and forwards the click', () => {
    const loadMore = vi.fn();
    useJobLogTail.mockReturnValue(tail({ entries, hasMore: true, loadMore }));
    renderViewer();
    fireEvent.click(screen.getByText('Load more'));
    expect(loadMore).toHaveBeenCalledTimes(1);
  });

  it('disables load more while the next page is being fetched', () => {
    useJobLogTail.mockReturnValue(tail({ entries, hasMore: true, isFetchingMore: true }));
    renderViewer();
    expect(screen.getByText('Load more')).toBeDisabled();
  });

  it('hides the load more button when the stream is caught up', () => {
    useJobLogTail.mockReturnValue(tail({ entries }));
    renderViewer();
    expect(screen.queryByText('Load more')).not.toBeInTheDocument();
  });

  it('shows the error state when the stream fails', () => {
    useJobLogTail.mockReturnValue(tail({ isError: true, error: { status: 500 } }));
    renderViewer();
    expect(screen.getByText('Failed to load job logs.')).toBeInTheDocument();
  });

  it('shows the access message when the server forbids the stream', () => {
    useJobLogTail.mockReturnValue(tail({ isError: true, isForbidden: true, error: { status: 403 } }));
    renderViewer();
    expect(screen.getByText('You do not have access to job logs.')).toBeInTheDocument();
  });

  it('reads a missing stream as no retained log', () => {
    useJobLogTail.mockReturnValue(tail({ isError: true, error: { status: 404 } }));
    renderViewer();
    expect(screen.getByText('No log stream is retained for this job.')).toBeInTheDocument();
  });

  it('does not open the stream without the job log gate', () => {
    access.value = false;
    renderViewer();
    expect(screen.getByText('You do not have access to job logs.')).toBeInTheDocument();
    expect(useJobLogTail).not.toHaveBeenCalled();
  });

  it('shows a skeleton while the gates are still loading', () => {
    access.loading = true;
    const { container } = renderViewer();
    expect(container.querySelector('.animate-pulse')).not.toBeNull();
    expect(screen.queryByText('You do not have access to job logs.')).not.toBeInTheDocument();
    expect(useJobLogTail).not.toHaveBeenCalled();
  });

  it('keeps the view pinned to the newest entry while following', () => {
    useJobLogTail.mockReturnValue(tail({ entries, isTailing: true }));
    const view = renderViewer(true);
    const container = scrollContainer();
    fakeScrollMetrics(container, 0);
    useJobLogTail.mockReturnValue(tail({ entries: [...entries, { ...entries[1], id: 'e3' }], isTailing: true }));
    view.rerender(<JobLogViewer key="job-1" jobId="job-1" inFlight={true} />);
    expect(container.scrollTop).toBe(1000);
    expect(screen.queryByText('Jump to latest')).not.toBeInTheDocument();
  });

  it('offers a jump to latest after the reader scrolls up', () => {
    useJobLogTail.mockReturnValue(tail({ entries, isTailing: true }));
    renderViewer(true);
    const container = scrollContainer();
    fakeScrollMetrics(container, 100);
    fireEvent.scroll(container);
    fireEvent.click(screen.getByText('Jump to latest'));
    expect(container.scrollTop).toBe(1000);
    expect(screen.queryByText('Jump to latest')).not.toBeInTheDocument();
  });
});
