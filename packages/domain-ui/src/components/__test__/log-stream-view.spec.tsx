import type { JobLogEntry } from '@repo/api-client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { PagedLogTail } from '../../hooks/use-paged-log-tail';

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

import { LogStreamView } from '../log-stream-view';

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

function tail(over: Partial<PagedLogTail> = {}): PagedLogTail {
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

function renderView(over: Partial<PagedLogTail> = {}, showLevelFilter = true) {
  return render(
    <LogStreamView
      tail={tail(over)}
      ariaLabel="Serial console output"
      emptyMessage="Nothing stored."
      waitingMessage="Waiting for console output."
      showLevelFilter={showLevelFilter}
    />,
  );
}

describe('LogStreamView', () => {
  it('labels the log region with the given aria label', () => {
    renderView({ entries });
    const log = screen.getByRole('log', { name: 'Serial console output' });
    expect(within(log).getByText('provision started')).toBeInTheDocument();
    expect(within(log).getByText('ipmi power on failed')).toBeInTheDocument();
  });

  it('shows the level select and a badge per row by default', () => {
    renderView({ entries });
    const log = screen.getByRole('log', { name: 'Serial console output' });
    expect(screen.getByTestId('level-select')).toBeInTheDocument();
    expect(within(log).getByText('info')).toBeInTheDocument();
    expect(within(log).getByText('error')).toBeInTheDocument();
  });

  it('keeps the search input but drops the level select and badges when the level filter is off', () => {
    renderView({ entries }, false);
    const log = screen.getByRole('log', { name: 'Serial console output' });
    expect(screen.getByPlaceholderText('Search messages')).toBeInTheDocument();
    expect(screen.queryByTestId('level-select')).not.toBeInTheDocument();
    expect(within(log).queryByText('info')).not.toBeInTheDocument();
    expect(within(log).queryByText('error')).not.toBeInTheDocument();
    expect(within(log).getByText('provision started')).toBeInTheDocument();
  });

  it('shows the waiting message while tailing an empty stream', () => {
    renderView({ isTailing: true });
    expect(screen.getByText('Waiting for console output.')).toBeInTheDocument();
    expect(screen.getByText('Following live output')).toBeInTheDocument();
  });

  it('shows the empty message on an idle empty stream', () => {
    renderView();
    expect(screen.getByText('Nothing stored.')).toBeInTheDocument();
    expect(screen.queryByText('Following live output')).not.toBeInTheDocument();
  });

  it('filters rows by message substring without the level filter', () => {
    renderView({ entries }, false);
    fireEvent.change(screen.getByPlaceholderText('Search messages'), { target: { value: 'IPMI' } });
    expect(screen.getByText('ipmi power on failed')).toBeInTheDocument();
    expect(screen.queryByText('provision started')).not.toBeInTheDocument();
  });
});
