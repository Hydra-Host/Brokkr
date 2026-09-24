import type { ExportLogsJobType, SolLogsResponse } from '@repo/api-client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface GetLogsArgs {
  params: { id: string };
  body: { jobType: ExportLogsJobType };
}

type GetLogsResult = { status: 200; body: SolLogsResponse } | { status: 404 | 500; body: { message: string } };

const { getLogs } = vi.hoisted(() => ({
  getLogs: vi.fn<(args: GetLogsArgs) => Promise<GetLogsResult>>(),
}));

vi.mock('~/lib/api', () => ({ tsr: { getLogs: { mutate: getLogs } } }));

vi.mock('@repo/ui/components/select', () => ({
  Select: (props: { value?: string; onValueChange?: (value: string) => void; children?: ReactNode }) => (
    <select
      data-testid="job-type-select"
      value={props.value}
      onChange={(event) => props.onValueChange?.(event.target.value)}
    >
      {['Provision', 'Reprovision', 'Deprovision'].map((value) => (
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

import { NO_SOL_LOG_MESSAGE } from '@repo/domain-ui/components/sol-log-viewer';
import { DeploymentSerialLogCard } from './deployment-serial-log-card';

function response(lines: string[], complete = false): GetLogsResult {
  return {
    status: 200,
    body: {
      success: true,
      message: '',
      complete,
      entries: lines.map((message) => ({ timestamp: '2026-09-16T14:02:19.000Z', message })),
    },
  };
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DeploymentSerialLogCard deploymentId="dep-1" />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  getLogs.mockReset();
});

describe('DeploymentSerialLogCard', () => {
  it('requests the provision log on mount and renders the lines in the console region', async () => {
    getLogs.mockResolvedValue(response(['iPXE 1.21.1', 'ubuntu login:']));
    renderCard();
    const log = await screen.findByRole('log', { name: 'Serial console output' });
    expect(getLogs).toHaveBeenCalledWith({ params: { id: 'dep-1' }, body: { jobType: 'Provision' } });
    expect(within(log).getByText('iPXE 1.21.1')).toBeInTheDocument();
    expect(within(log).getByText('ubuntu login:')).toBeInTheDocument();
    expect(screen.getByText('Following live output')).toBeInTheDocument();
  });

  it('shows no live indicator once the capture is complete', async () => {
    getLogs.mockResolvedValue(response(['iPXE 1.21.1'], true));
    renderCard();
    await screen.findByRole('log', { name: 'Serial console output' });
    expect(screen.queryByText('Following live output')).not.toBeInTheDocument();
  });

  it('names the 24-hour window when a finished capture stored no line', async () => {
    getLogs.mockResolvedValue(response([], true));
    renderCard();
    expect(await screen.findByText(NO_SOL_LOG_MESSAGE)).toBeInTheDocument();
  });

  it('says when no job of that type has run', async () => {
    getLogs.mockResolvedValue({ status: 404, body: { message: 'Not found' } });
    renderCard();
    expect(await screen.findByText('No Provision job has run for this deployment.')).toBeInTheDocument();
  });

  it('reads the other job type when the select changes and drops the previous lines', async () => {
    getLogs.mockResolvedValueOnce(response(['iPXE 1.21.1'])).mockResolvedValue(response(['wipe started']));
    renderCard();
    await screen.findByText('iPXE 1.21.1');
    fireEvent.change(screen.getByTestId('job-type-select'), { target: { value: 'Deprovision' } });
    await waitFor(() =>
      expect(getLogs).toHaveBeenLastCalledWith({ params: { id: 'dep-1' }, body: { jobType: 'Deprovision' } }),
    );
    expect(await screen.findByText('wipe started')).toBeInTheDocument();
    expect(screen.queryByText('iPXE 1.21.1')).not.toBeInTheDocument();
  });
});
