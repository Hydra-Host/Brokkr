// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueueJobPage, QueueSummary } from '@/contract';

const mocks = vi.hoisted(() => ({
  search: {
    queuePrefix: 'zone-a' as string | undefined,
    queueName: 'lifecycle' as string | undefined,
    jobState: undefined,
    jobId: undefined,
    deviceId: undefined,
    queueFilter: undefined,
  },
  listQueues: vi.fn(),
  listQueueJobs: vi.fn(),
  refetchQueues: vi.fn(),
  navigate: vi.fn(),
  toast: { ok: vi.fn(), error: vi.fn(), info: vi.fn() },
  retry: { mutate: vi.fn(), isPending: false },
  remove: { mutate: vi.fn(), isPending: false },
  drain: { mutate: vi.fn(), isPending: false },
  clean: { mutate: vi.fn(), isPending: false },
}));

vi.mock('@/lib/api', () => ({
  tsr: {
    listQueues: { useQuery: mocks.listQueues },
    listQueueJobs: { query: mocks.listQueueJobs },
    getQueueJob: { useQuery: vi.fn() },
    retryQueueJob: { useMutation: () => mocks.retry },
    removeQueueJob: { useMutation: () => mocks.remove },
    drainQueue: { useMutation: () => mocks.drain },
    cleanQueue: { useMutation: () => mocks.clean },
  },
}));
vi.mock('@/lib/toast', () => ({ useToast: () => mocks.toast }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useSearch: () => mocks.search,
  useNavigate: () => mocks.navigate,
}));

import { QueuesTab } from './queues-tab';

function summary(overrides: Partial<QueueSummary> = {}): QueueSummary {
  return {
    prefix: 'zone-a',
    name: 'lifecycle',
    kind: 'saga',
    counts: {
      wait: 1,
      active: 0,
      paused: 0,
      delayed: 0,
      prioritized: 0,
      'waiting-children': 0,
      completed: 5,
      failed: 2,
    },
    stalled: 0,
    paused: false,
    workers: 1,
    inFlight: 1,
    readError: null,
    ...overrides,
  };
}

function page(): QueueJobPage {
  return {
    queue: { prefix: 'zone-a', name: 'lifecycle', kind: 'saga' },
    states: ['wait'],
    limit: 50,
    offset: 0,
    deviceId: null,
    deviceFilterSupported: true,
    cap: 200,
    jobs: [],
    truncated: false,
    discoveryCapped: false,
  };
}

const flush = () => act(async () => {});

async function renderTab() {
  const utils = render(<QueuesTab />);
  await flush();
  return utils;
}

beforeEach(() => {
  mocks.search.queuePrefix = 'zone-a';
  mocks.search.queueName = 'lifecycle';
  mocks.listQueues.mockReset();
  mocks.listQueues.mockReturnValue({
    data: { status: 200, body: [summary()] },
    error: undefined,
    isLoading: false,
    refetch: mocks.refetchQueues,
  });
  mocks.listQueueJobs.mockReset();
  mocks.listQueueJobs.mockResolvedValue({ status: 200, body: page() });
  mocks.refetchQueues.mockReset();
  mocks.navigate.mockReset();
  mocks.toast.ok.mockReset();
  mocks.toast.error.mockReset();
  mocks.drain.mutate.mockReset();
  mocks.clean.mutate.mockReset();
});

afterEach(cleanup);

describe('QueuesTab queue actions', () => {
  it('disables drain and clean until a queue is selected', async () => {
    mocks.search.queuePrefix = undefined;
    mocks.search.queueName = undefined;
    await renderTab();

    expect(screen.getByRole('button', { name: 'drain' }).getAttribute('disabled')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'clean' }).getAttribute('disabled')).not.toBeNull();
  });
});

describe('QueuesTab drain gate', () => {
  it('opens from the Jobs header and sends delayed false by default', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    expect(screen.getByText('Confirm: Drain zone-a/lifecycle')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Drain queue' }));
    expect(mocks.drain.mutate).toHaveBeenCalledWith(
      { params: { prefix: 'zone-a', name: 'lifecycle' }, body: { delayed: false } },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('flips the request body when the delayed checkbox is ticked', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'also remove delayed jobs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drain queue' }));

    expect(mocks.drain.mutate.mock.calls[0][0].body).toEqual({ delayed: true });
  });

  it('resets the delayed option after a confirmed drain', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'also remove delayed jobs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drain queue' }));

    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    expect(screen.getByRole('checkbox', { name: 'also remove delayed jobs' })).toHaveProperty('checked', false);
  });

  it('resets the delayed option after a cancelled drain', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'also remove delayed jobs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    expect(screen.getByRole('checkbox', { name: 'also remove delayed jobs' })).toHaveProperty('checked', false);
  });

  it('refetches the queues, remounts the job list, and toasts on success', async () => {
    await renderTab();
    expect(mocks.listQueueJobs).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drain queue' }));
    const options = mocks.drain.mutate.mock.calls[0][1];
    await act(async () => options.onSuccess({ status: 200, body: { runId: 'run-1' } }));

    expect(mocks.toast.ok).toHaveBeenCalledWith('drained queue');
    expect(mocks.refetchQueues).toHaveBeenCalledTimes(1);
    expect(mocks.listQueueJobs).toHaveBeenCalledTimes(2);
  });

  it('shows a rejected drain’s body as the toast text', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drain queue' }));
    const options = mocks.drain.mutate.mock.calls[0][1];
    await act(async () => options.onError({ status: 404, body: { error: 'queue absent' } }));

    expect(mocks.toast.error).toHaveBeenCalledWith('drain — queue absent');
    expect(mocks.refetchQueues).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('clears the selected job after a successful drain', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    fireEvent.click(screen.getByRole('button', { name: 'Drain queue' }));
    const options = mocks.drain.mutate.mock.calls[0][1];
    await act(async () => options.onSuccess({ status: 200, body: { runId: 'run-1' } }));

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    const nav = mocks.navigate.mock.calls[0][0];
    expect(nav.search({ tab: 'queues', jobId: 'job-9' }).jobId).toBeUndefined();
  });
});

describe('QueuesTab clean gate', () => {
  it('sends the selected state, grace, and limit', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'clean' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'state' }), { target: { value: 'completed' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'grace (ms)' }), { target: { value: '60000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clean queue' }));

    expect(mocks.clean.mutate).toHaveBeenCalledWith(
      { params: { prefix: 'zone-a', name: 'lifecycle' }, body: { state: 'completed', grace: 60000, limit: 1000 } },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('defaults to failed jobs with zero grace', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'clean' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clean queue' }));

    expect(mocks.clean.mutate.mock.calls[0][0].body).toEqual({ state: 'failed', grace: 0, limit: 1000 });
  });

  it('resets state and grace after a confirmed clean', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'clean' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'state' }), { target: { value: 'completed' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'grace (ms)' }), { target: { value: '60000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clean queue' }));

    fireEvent.click(screen.getByRole('button', { name: 'clean' }));
    expect(screen.getByRole('combobox', { name: 'state' })).toHaveProperty('value', 'failed');
    expect(screen.getByRole('spinbutton', { name: 'grace (ms)' })).toHaveProperty('value', '0');
  });

  it('resets state and grace after a cancelled clean', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'clean' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'state' }), { target: { value: 'completed' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'grace (ms)' }), { target: { value: '60000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByRole('button', { name: 'clean' }));
    expect(screen.getByRole('combobox', { name: 'state' })).toHaveProperty('value', 'failed');
    expect(screen.getByRole('spinbutton', { name: 'grace (ms)' })).toHaveProperty('value', '0');
  });

  it('offers exactly the six cleanable states', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'clean' }));

    const options = screen.getByRole('combobox', { name: 'state' }).querySelectorAll('option');
    expect([...options].map((option) => option.value)).toEqual([
      'completed',
      'failed',
      'wait',
      'paused',
      'delayed',
      'prioritized',
    ]);
  });

  it('clears the selected job after a successful clean', async () => {
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'clean' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clean queue' }));
    const options = mocks.clean.mutate.mock.calls[0][1];
    await act(async () => options.onSuccess({ status: 200, body: { runId: 'run-1' } }));

    expect(mocks.navigate).toHaveBeenCalledTimes(1);
    const nav = mocks.navigate.mock.calls[0][0];
    expect(nav.search({ tab: 'queues', jobId: 'job-9' }).jobId).toBeUndefined();
  });
});

describe('QueuesTab gate options across queues', () => {
  const twoQueues = () =>
    mocks.listQueues.mockReturnValue({
      data: { status: 200, body: [summary(), summary({ prefix: 'zone-b', name: 'exports' })] },
      error: undefined,
      isLoading: false,
      refetch: mocks.refetchQueues,
    });

  it('opens defaulted after switching queues with the gate closed', async () => {
    twoQueues();
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'also remove delayed jobs' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    fireEvent.click(screen.getByText('exports'));
    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    expect(screen.getByRole('checkbox', { name: 'also remove delayed jobs' })).toHaveProperty('checked', false);
  });

  it('closes an open gate and drops its options when the queue changes', async () => {
    twoQueues();
    await renderTab();
    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'also remove delayed jobs' }));

    fireEvent.click(screen.getByText('exports'));
    expect(screen.queryByText('Confirm: Drain zone-a/lifecycle')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'drain' }));
    expect(screen.getByRole('checkbox', { name: 'also remove delayed jobs' })).toHaveProperty('checked', false);
  });
});
