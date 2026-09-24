import type { JobLogEntry } from '@repo/api-client';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SolLogTail } from '../../hooks/use-sol-log-tail';

const { useSolLogTail } = vi.hoisted(() => ({ useSolLogTail: vi.fn() }));

vi.mock('../../hooks/use-sol-log-tail', () => ({ useSolLogTail }));

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

import { NO_SOL_LOG_MESSAGE, SolLogViewer } from '../sol-log-viewer';

const entries: JobLogEntry[] = [
  {
    id: '0',
    timestamp: '2026-08-01T10:00:00',
    logLevel: 'info',
    message: 'iPXE 1.21.1',
    appName: 'bridge-api',
    appClassName: '',
  },
  {
    id: '1',
    timestamp: '2026-08-01T10:00:01',
    logLevel: 'info',
    message: 'ubuntu login:',
    appName: 'bridge-api',
    appClassName: '',
  },
];

function tail(over: Partial<SolLogTail> = {}): SolLogTail {
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

function renderViewer(inFlight = true) {
  return render(<SolLogViewer key="job-1" deviceId="dev-1" jobId="job-1" inFlight={inFlight} />);
}

describe('SolLogViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tails the job on its device and renders the console lines without level chrome', () => {
    useSolLogTail.mockReturnValue(tail({ entries }));
    renderViewer();
    expect(useSolLogTail).toHaveBeenCalledWith('dev-1', 'job-1', true);
    const log = screen.getByRole('log', { name: 'Serial console output' });
    expect(within(log).getByText('iPXE 1.21.1')).toBeInTheDocument();
    expect(within(log).getByText('ubuntu login:')).toBeInTheDocument();
    expect(screen.queryByTestId('level-select')).not.toBeInTheDocument();
    expect(within(log).queryByText('info')).not.toBeInTheDocument();
  });

  it('reads a missing list as no stored console output', () => {
    useSolLogTail.mockReturnValue(tail({ isError: true, error: { status: 404 } }));
    renderViewer();
    expect(screen.getByText(NO_SOL_LOG_MESSAGE)).toBeInTheDocument();
  });

  it('reads an idle empty tail as no stored console output', () => {
    useSolLogTail.mockReturnValue(tail());
    renderViewer(false);
    expect(screen.getByText(NO_SOL_LOG_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByText('Following live output')).not.toBeInTheDocument();
  });

  it('waits for console output while tailing an empty list', () => {
    useSolLogTail.mockReturnValue(tail({ isTailing: true }));
    renderViewer();
    expect(screen.getByText('Waiting for console output.')).toBeInTheDocument();
    expect(screen.getByText('Following live output')).toBeInTheDocument();
  });

  it('shows the access message when the server forbids the list', () => {
    useSolLogTail.mockReturnValue(tail({ isError: true, isForbidden: true, error: { status: 403 } }));
    renderViewer();
    expect(screen.getByText('You do not have access to job logs.')).toBeInTheDocument();
  });

  it('shows the error state when the list fails to load', () => {
    useSolLogTail.mockReturnValue(tail({ isError: true, error: { status: 500 } }));
    renderViewer();
    expect(screen.getByText('Failed to load serial console output.')).toBeInTheDocument();
  });
});
