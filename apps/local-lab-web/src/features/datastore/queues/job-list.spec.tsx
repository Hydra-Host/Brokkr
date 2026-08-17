// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueueJob, QueueJobPage } from '@/contract';

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/api', () => ({ tsr: { listQueueJobs: { query: mocks.query } } }));

import { JobList, JobTable } from './job-list';

function job(overrides: Partial<QueueJob> = {}): QueueJob {
  return {
    id: 'job-1',
    name: 'saga.run',
    state: 'wait',
    attemptsMade: 0,
    timestamp: 1000,
    processedOn: null,
    finishedOn: null,
    delay: 0,
    failedReason: null,
    deviceId: null,
    sagaName: null,
    planId: null,
    sealed: false,
    zoneId: null,
    ...overrides,
  };
}

function page(overrides: Partial<QueueJobPage> = {}): QueueJobPage {
  return {
    queue: { prefix: 'zone-a', name: 'inbox', kind: 'results' },
    states: ['wait'],
    limit: 50,
    offset: 0,
    deviceId: null,
    deviceFilterSupported: true,
    cap: 200,
    jobs: [],
    truncated: false,
    discoveryCapped: false,
    ...overrides,
  };
}

type ListProps = ComponentProps<typeof JobList>;

const LIST_PROPS: ListProps = {
  queue: { prefix: 'zone-a', name: 'inbox' },
  jobState: undefined,
  deviceId: undefined,
  selectedJobId: undefined,
  onSelectJob: vi.fn(),
  onSelectState: vi.fn(),
  onClearDevice: vi.fn(),
};

const flush = () => act(async () => {});

async function renderList(overrides: Partial<ListProps> = {}) {
  const utils = render(<JobList {...LIST_PROPS} {...overrides} />);
  await flush();
  return utils;
}

afterEach(cleanup);

describe('JobTable', () => {
  it('does not render delayed as a failure while it does render failed as one', () => {
    render(
      <JobTable
        jobs={[job({ id: 'a', state: 'delayed' }), job({ id: 'b', state: 'failed' })]}
        selectedId={undefined}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('delayed').className).not.toContain('status-offline');
    expect(screen.getByText('failed').className).toContain('status-offline');
  });

  it('shows an unchanged attempt count on a delayed job', () => {
    render(<JobTable jobs={[job({ state: 'delayed', attemptsMade: 0 })]} selectedId={undefined} onSelect={vi.fn()} />);
    expect(screen.getByText('0 att').className).not.toContain('status-warning');
  });

  it('flags a climbing attempt count', () => {
    render(<JobTable jobs={[job({ attemptsMade: 2 })]} selectedId={undefined} onSelect={vi.fn()} />);
    expect(screen.getByText('2 att').className).toContain('status-warning');
  });

  it('marks a sealed job without revealing anything of its payload', () => {
    render(<JobTable jobs={[job({ sealed: true })]} selectedId={undefined} onSelect={vi.fn()} />);
    expect(screen.getByText('sealed')).toBeDefined();
  });

  it('selects a job by id', () => {
    const onSelect = vi.fn();
    render(<JobTable jobs={[job({ id: 'zone-1-provision' })]} selectedId={undefined} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('zone-1-provision'));
    expect(onSelect).toHaveBeenCalledWith('zone-1-provision');
  });

  it('renders nothing when the queue read returned no jobs', () => {
    const { container } = render(<JobTable jobs={[]} selectedId={undefined} onSelect={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});

describe('JobList path params', () => {
  beforeEach(() => {
    mocks.query.mockReset();
    mocks.query.mockResolvedValue({ status: 200, body: page() });
  });

  it('encodes a prefix and queue name that would otherwise escape their path segments', async () => {
    await renderList({ queue: { prefix: 'zone/a', name: 'in?box' } });

    expect(mocks.query.mock.calls[0][0].params).toEqual({ prefix: 'zone%2Fa', name: 'in%3Fbox' });
  });

  it('leaves an ordinary prefix and queue name byte-identical', async () => {
    await renderList();

    expect(mocks.query.mock.calls[0][0].params).toEqual({ prefix: 'zone-a', name: 'inbox' });
  });
});

describe('JobList paging', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('offers a further offset while the discovery cap has not cut the device read', async () => {
    mocks.query.mockResolvedValue({ status: 200, body: page({ deviceId: 'dev-1', jobs: [job()], truncated: true }) });
    await renderList({ deviceId: 'dev-1' });

    expect(screen.getByText(/load more/)).toBeDefined();
    expect(screen.queryByText(/unreachable/)).toBeNull();
  });

  it('withholds a further offset and states the remainder is unreachable once discovery is capped', async () => {
    mocks.query.mockResolvedValue({
      status: 200,
      body: page({ deviceId: 'dev-1', jobs: [job()], truncated: true, discoveryCapped: true, cap: 200 }),
    });
    await renderList({ deviceId: 'dev-1' });

    expect(screen.queryByText(/load more/)).toBeNull();
    expect(screen.getByText(/the remainder is unreachable from here/).textContent).toContain('200');
  });

  it('does not suggest narrowing by state, which the cap makes no difference to', async () => {
    mocks.query.mockResolvedValue({
      status: 200,
      body: page({ deviceId: 'dev-1', jobs: [job()], truncated: true, discoveryCapped: true }),
    });
    const { container } = await renderList({ deviceId: 'dev-1' });

    expect(container.textContent).not.toMatch(/narrow/i);
  });

  it('stops offering a further offset once a load-more page comes back empty', async () => {
    mocks.query.mockResolvedValue({ status: 200, body: page({ jobs: [job()], truncated: true }) });
    await renderList();
    const button = screen.getByText(/load more/);

    mocks.query.mockResolvedValue({ status: 200, body: page({ jobs: [], truncated: true }) });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.queryByText(/load more/)).toBeNull();
  });
});

describe('JobList device filter', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('reports a device filter it cannot answer rather than an absent device', async () => {
    mocks.query.mockResolvedValue({
      status: 200,
      body: page({ deviceId: 'dev-1', deviceFilterSupported: false, jobs: [] }),
    });
    await renderList({ deviceId: 'dev-1' });

    expect(screen.getByText(/cannot be determined from job ids/)).toBeDefined();
    expect(screen.getByText(/device filter cannot be answered for this queue/)).toBeDefined();
    expect(screen.queryByText('no jobs for this device in this queue')).toBeNull();
  });

  it('keeps the unanswerable wording apart from a genuinely empty device result', async () => {
    mocks.query.mockResolvedValue({ status: 200, body: page({ deviceId: 'dev-1', jobs: [] }) });
    await renderList({ deviceId: 'dev-1' });

    expect(screen.getByText('no jobs for this device in this queue')).toBeDefined();
    expect(screen.queryByText(/cannot be determined/)).toBeNull();
    expect(screen.queryByText(/cannot be answered/)).toBeNull();
  });
});

describe('JobList empty state', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('does not claim an absence while a further offset is still on offer [crg-finding: medium-local-lab-web-no-jobs-empty-state-message-displayed-simultaneously-wit]', async () => {
    mocks.query.mockResolvedValue({ status: 200, body: page({ jobs: [], truncated: true, discoveryCapped: false }) });
    await renderList();

    expect(screen.getByText('no matching jobs in this window — load more to continue scanning')).toBeDefined();
    expect(screen.queryByText('no jobs in the states read')).toBeNull();
    expect(screen.queryByText('no jobs for this device in this queue')).toBeNull();
    expect(screen.getByRole('button', { name: /load more/ })).toBeDefined();
  });

  it('states the absence outright once no further offset remains', async () => {
    mocks.query.mockResolvedValue({ status: 200, body: page({ jobs: [], truncated: false }) });
    await renderList();

    expect(screen.getByText('no jobs in the states read')).toBeDefined();
    expect(screen.queryByText(/continue scanning/)).toBeNull();
    expect(screen.queryByRole('button', { name: /load more/ })).toBeNull();
  });
});

describe('JobList failed reload', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('drops the previous filter rows when a reset load returns an error', async () => {
    mocks.query.mockResolvedValue({ status: 200, body: page({ jobs: [job({ id: 'wait-job-1' })] }) });
    const { rerender } = render(<JobList {...LIST_PROPS} jobState="wait" />);
    await flush();
    expect(screen.getByText('wait-job-1')).toBeDefined();

    mocks.query.mockResolvedValue({ status: 500, body: { error: 'redis read failed' } });
    rerender(<JobList {...LIST_PROPS} jobState="failed" />);
    await flush();

    expect(screen.getByText('redis read failed')).toBeDefined();
    expect(screen.queryByText('wait-job-1')).toBeNull();
  });

  it('drops the previous filter rows and its offset when a reset load throws', async () => {
    mocks.query.mockResolvedValue({ status: 200, body: page({ jobs: [job({ id: 'wait-job-1' })], truncated: true }) });
    const { rerender } = render(<JobList {...LIST_PROPS} jobState="wait" />);
    await flush();
    expect(screen.getByText(/load more/)).toBeDefined();

    mocks.query.mockRejectedValue(new Error('network down'));
    rerender(<JobList {...LIST_PROPS} jobState="failed" />);
    await flush();

    expect(screen.getByText(/network down/)).toBeDefined();
    expect(screen.queryByText('wait-job-1')).toBeNull();
    expect(screen.queryByText(/load more/)).toBeNull();
  });

  it('keeps the rows already read when a load-more page fails', async () => {
    mocks.query.mockResolvedValue({ status: 200, body: page({ jobs: [job({ id: 'wait-job-1' })], truncated: true }) });
    await renderList();
    const button = screen.getByText(/load more/);

    mocks.query.mockResolvedValue({ status: 500, body: { error: 'redis read failed' } });
    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.getByText('redis read failed')).toBeDefined();
    expect(screen.getByText('wait-job-1')).toBeDefined();
  });
});
