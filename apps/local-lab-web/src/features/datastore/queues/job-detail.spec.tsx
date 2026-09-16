// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { QueueJobDetail } from '@/contract';

const mocks = vi.hoisted(() => ({
  useQuery: vi.fn(),
  navigate: vi.fn(),
  toast: { ok: vi.fn(), error: vi.fn(), info: vi.fn() },
  retry: { mutate: vi.fn(), isPending: false },
  remove: { mutate: vi.fn(), isPending: false },
  drain: { mutate: vi.fn(), isPending: false },
  clean: { mutate: vi.fn(), isPending: false },
}));
vi.mock('@/lib/api', () => ({
  tsr: {
    getQueueJob: { useQuery: mocks.useQuery },
    retryQueueJob: { useMutation: () => mocks.retry },
    removeQueueJob: { useMutation: () => mocks.remove },
    drainQueue: { useMutation: () => mocks.drain },
    cleanQueue: { useMutation: () => mocks.clean },
  },
}));
vi.mock('@/lib/toast', () => ({ useToast: () => mocks.toast }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => mocks.navigate,
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

import { JobDetailPanel, JobDetailView } from './job-detail';

const QUEUE = { prefix: 'bull', name: 'device-data-reconcile' };
const REPEATABLE_ID = 'repeat:device-data-reconcile-sweep:1785955080000';

function detail(overrides: Partial<QueueJobDetail> = {}): QueueJobDetail {
  return {
    id: 'dev-1-provision',
    name: 'saga.run',
    state: 'failed',
    attemptsMade: 3,
    timestamp: 1_700_000_000_000,
    processedOn: 1_700_000_001_000,
    finishedOn: 1_700_000_004_000,
    delay: 0,
    failedReason: 'ipmi power on timed out',
    deviceId: 'dev-1',
    sagaName: 'provision',
    planId: 'plan-9',
    sealed: false,
    zoneId: 'zone-a',
    aad: null,
    payload: null,
    payloadTruncated: false,
    stacktrace: [],
    ...overrides,
  };
}

const AAD = {
  aad_v: 1,
  zone_id: 'zone-a',
  queue_name: 'lifecycle',
  direction: 'hub_to_bridge',
  job_id: 'dev-1-provision',
  created_at: 1_700_000_000_000,
};

afterEach(cleanup);

describe('JobDetailView', () => {
  it('renders a sealed job’s aad header and nothing of its sealed body', () => {
    render(<JobDetailView job={detail({ sealed: true, aad: AAD })} />);
    expect(screen.getByText('sealed')).toBeDefined();
    expect(screen.getByText(/AAD header/)).toBeDefined();
    expect(screen.getByText(/"direction": "hub_to_bridge"/)).toBeDefined();
    expect(screen.queryByText(/ciphertext/i)).toBeNull();
    expect(screen.queryByText(/envelope_v/)).toBeNull();
    expect(screen.queryByText(/^payload$/i)).toBeNull();
  });

  it('omits the aad section for an unsealed job', () => {
    render(<JobDetailView job={detail()} />);
    expect(screen.queryByText(/AAD header/)).toBeNull();
  });

  it('renders the redacted payload of an unsealed job', () => {
    render(
      <JobDetailView
        job={detail({
          payload: { saga_name: 'provision', lifecycle_data: { user_data: '***', pubkeys: '<redacted: 2 items>' } },
        })}
      />,
    );
    expect(screen.getByText(/^payload$/i)).toBeDefined();
    expect(screen.getByText(/"saga_name": "provision"/)).toBeDefined();
    expect(screen.getByText(/"user_data": "\*\*\*"/)).toBeDefined();
    expect(screen.getByText(/"pubkeys": "<redacted: 2 items>"/)).toBeDefined();
    expect(screen.queryByText(/truncated — a prefix/)).toBeNull();
  });

  it('notes when the payload is a capped prefix', () => {
    render(<JobDetailView job={detail({ payload: { dmi: 'x'.repeat(100) }, payloadTruncated: true })} />);
    expect(screen.getByText('truncated — a prefix, not the whole job data')).toBeDefined();
  });

  it('renders no payload section when the payload is null', () => {
    render(<JobDetailView job={detail({ payload: null })} />);
    expect(screen.queryByText(/^payload$/i)).toBeNull();
  });

  it('renders the failure message and the retained stack frames oldest first', () => {
    render(<JobDetailView job={detail({ stacktrace: ['frame one', 'frame two'] })} />);
    expect(screen.getByText('ipmi power on timed out')).toBeDefined();
    expect(screen.getByText(/2 frames, oldest first/)).toBeDefined();
    expect(screen.getByText(/frame one[\s\S]*frame two/)).toBeDefined();
  });

  it('renders timing and attempts', () => {
    render(<JobDetailView job={detail()} />);
    expect(screen.getByText('2023-11-14 22:13:20.000')).toBeDefined();
    expect(screen.getByText('queued 1.0s')).toBeDefined();
    expect(screen.getByText('ran 3.0s')).toBeDefined();
    expect(screen.getByText('3')).toBeDefined();
  });

  it('renders the parsed identity fields and a dash for an absent stamp', () => {
    render(<JobDetailView job={detail({ finishedOn: null, planId: null })} />);
    expect(screen.getByText('dev-1')).toBeDefined();
    expect(screen.getByText('provision')).toBeDefined();
    expect(screen.getByText('zone-a')).toBeDefined();
    expect(screen.getByText('—')).toBeDefined();
    expect(screen.getByText('null')).toBeDefined();
  });
});

describe('JobDetailPanel path params', () => {
  beforeEach(() => {
    mocks.useQuery.mockReset();
    mocks.useQuery.mockReturnValue({ data: undefined, error: undefined });
  });

  it('encodes a repeatable job id, whose colons ts-rest would otherwise splice in raw', () => {
    render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);

    const { params } = mocks.useQuery.mock.calls[0][0].queryData;
    expect(params.jobId).toBe('repeat%3Adevice-data-reconcile-sweep%3A1785955080000');
  });

  it('encodes a job id that would otherwise escape its own path segment', () => {
    render(<JobDetailPanel queue={QUEUE} jobId="dev/1?x=2#frag" onChanged={vi.fn()} />);

    const { params } = mocks.useQuery.mock.calls[0][0].queryData;
    expect(params.jobId).toBe('dev%2F1%3Fx%3D2%23frag');
  });

  it('keeps the raw job id in the cache key so it is not encoded twice on a refetch', () => {
    render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);

    expect(mocks.useQuery.mock.calls[0][0].queryKey).toEqual([
      'queue-job',
      'bull',
      'device-data-reconcile',
      REPEATABLE_ID,
    ]);
  });

  it('leaves an ordinary prefix and queue name byte-identical', () => {
    render(<JobDetailPanel queue={QUEUE} jobId="dev-1-provision" onChanged={vi.fn()} />);

    const { params } = mocks.useQuery.mock.calls[0][0].queryData;
    expect(params.prefix).toBe('bull');
    expect(params.name).toBe('device-data-reconcile');
    expect(params.jobId).toBe('dev-1-provision');
  });
});

describe('JobDetailPanel failures', () => {
  beforeEach(() => {
    mocks.useQuery.mockReset();
  });

  it('renders the message of a thrown 400 rather than the stringified response object', () => {
    mocks.useQuery.mockReturnValue({
      data: undefined,
      error: { status: 400, body: { error: 'jobId must not be empty' } },
    });
    const { container } = render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);

    expect(screen.getByText('jobId must not be empty')).toBeDefined();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('reports the status of a thrown response whose body carries no message', () => {
    mocks.useQuery.mockReturnValue({ data: undefined, error: { status: 500, body: {} } });
    const { container } = render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);

    expect(screen.getByText('request failed (500)')).toBeDefined();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('renders the message of a network failure that arrived as an error', () => {
    mocks.useQuery.mockReturnValue({ data: undefined, error: new Error('Failed to fetch') });
    const { container } = render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);

    expect(screen.getByText('Failed to fetch')).toBeDefined();
    expect(container.textContent).not.toContain('[object Object]');
  });

  it('renders the message of a non-200 that arrived in data rather than thrown', () => {
    mocks.useQuery.mockReturnValue({ data: { status: 404, body: { error: 'job absent' } }, error: undefined });
    const { container } = render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);

    expect(screen.getByText('job absent')).toBeDefined();
    expect(container.textContent).not.toContain('[object Object]');
  });
});

describe('JobDetailView actions', () => {
  it('shows retry and remove for a failed job when handlers are wired', () => {
    render(<JobDetailView job={detail()} onRetry={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'retry' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'remove' })).toBeDefined();
  });

  it('shows both actions for a completed job', () => {
    render(
      <JobDetailView job={detail({ state: 'completed', failedReason: null })} onRetry={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'retry' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'remove' })).toBeDefined();
  });

  it('shows neither action for an active job', () => {
    render(
      <JobDetailView job={detail({ state: 'active', failedReason: null })} onRetry={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'remove' })).toBeNull();
  });

  it('shows neither action for a job whose state is unknown', () => {
    render(
      <JobDetailView job={detail({ state: 'unknown', failedReason: null })} onRetry={vi.fn()} onRemove={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'remove' })).toBeNull();
  });

  it('shows remove but not retry for a waiting job', () => {
    render(<JobDetailView job={detail({ state: 'wait', failedReason: null })} onRetry={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'retry' })).toBeNull();
    expect(screen.getByRole('button', { name: 'remove' })).toBeDefined();
  });

  it('renders no actions without handlers', () => {
    render(<JobDetailView job={detail()} />);
    expect(screen.queryByRole('button', { name: 'retry' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'remove' })).toBeNull();
  });

  it('fires onRetry when retry is clicked', () => {
    const onRetry = vi.fn();
    render(<JobDetailView job={detail()} onRetry={onRetry} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('JobDetailPanel retry', () => {
  const refetch = vi.fn();

  beforeEach(() => {
    mocks.useQuery.mockReset();
    mocks.retry.mutate.mockReset();
    mocks.toast.ok.mockReset();
    mocks.toast.error.mockReset();
    refetch.mockReset();
    mocks.useQuery.mockReturnValue({
      data: { status: 200, body: detail({ id: REPEATABLE_ID }) },
      error: undefined,
      refetch,
    });
  });

  const clickRetry = () => fireEvent.click(screen.getByRole('button', { name: 'retry' }));

  it('retries with the encoded path params and the job state as the body', () => {
    render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);
    clickRetry();

    expect(mocks.retry.mutate).toHaveBeenCalledWith(
      {
        params: {
          prefix: 'bull',
          name: 'device-data-reconcile',
          jobId: 'repeat%3Adevice-data-reconcile-sweep%3A1785955080000',
        },
        body: { state: 'failed' },
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('sends the completed state when retrying a completed job, not a hardcoded failed', () => {
    mocks.useQuery.mockReturnValue({
      data: { status: 200, body: detail({ id: REPEATABLE_ID, state: 'completed' }) },
      error: undefined,
      refetch,
    });
    render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);
    clickRetry();

    expect(mocks.retry.mutate.mock.calls[0][0].body).toEqual({ state: 'completed' });
  });

  it('reports the change and refetches the detail after a successful retry', () => {
    const onChanged = vi.fn();
    render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={onChanged} />);
    clickRetry();

    const options = mocks.retry.mutate.mock.calls[0][1];
    act(() => options.onSuccess({ status: 200, body: { runId: 'run-1' } }));

    expect(mocks.toast.ok).toHaveBeenCalledWith('retried job');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 409 rejection as a retry-prefixed toast rather than reporting it retried', () => {
    const onChanged = vi.fn();
    render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={onChanged} />);
    clickRetry();

    const options = mocks.retry.mutate.mock.calls[0][1];
    act(() => options.onError({ status: 409, body: { error: 'job is active (locked by a worker)' } }));

    expect(mocks.toast.error).toHaveBeenCalledWith('retry — job is active (locked by a worker)');
    expect(mocks.toast.ok).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
  });

  it('surfaces a thrown network failure as a retry-prefixed toast', () => {
    render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);
    clickRetry();

    const options = mocks.retry.mutate.mock.calls[0][1];
    act(() => options.onError(new Error('fetch failed')));

    expect(mocks.toast.error).toHaveBeenCalledWith('retry — fetch failed');
  });
});

describe('JobDetailPanel remove gate', () => {
  beforeEach(() => {
    mocks.useQuery.mockReset();
    mocks.remove.mutate.mockReset();
    mocks.toast.ok.mockReset();
    mocks.toast.error.mockReset();
    mocks.navigate.mockReset();
    mocks.useQuery.mockReturnValue({ data: { status: 200, body: detail({ id: REPEATABLE_ID }) }, error: undefined });
  });

  function confirmRemove() {
    fireEvent.click(screen.getByRole('button', { name: 'remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove job' }));
  }

  it('opens the gate from remove and confirms with the encoded path params', () => {
    render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'remove' }));
    expect(screen.getByText(`Confirm: Remove job ${REPEATABLE_ID}`)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Remove job' }));
    expect(mocks.remove.mutate).toHaveBeenCalledWith(
      {
        params: {
          prefix: 'bull',
          name: 'device-data-reconcile',
          jobId: 'repeat%3Adevice-data-reconcile-sweep%3A1785955080000',
        },
      },
      expect.objectContaining({ onSuccess: expect.any(Function), onError: expect.any(Function) }),
    );
  });

  it('clears the selection and reports the change after a successful remove', () => {
    const onChanged = vi.fn();
    render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={onChanged} />);
    confirmRemove();

    const options = mocks.remove.mutate.mock.calls[0][1];
    act(() => options.onSuccess({ status: 200, body: { runId: 'run-1' } }));

    expect(mocks.toast.ok).toHaveBeenCalledWith('removed job');
    expect(onChanged).toHaveBeenCalledTimes(1);
    const nav = mocks.navigate.mock.calls[0][0];
    expect(nav.search({ tab: 'queues', jobId: REPEATABLE_ID }).jobId).toBeUndefined();
  });

  it('surfaces a 409 body as the toast text', () => {
    render(<JobDetailPanel queue={QUEUE} jobId={REPEATABLE_ID} onChanged={vi.fn()} />);
    confirmRemove();

    const options = mocks.remove.mutate.mock.calls[0][1];
    act(() => options.onError({ status: 409, body: { error: 'job is locked by a worker' } }));

    expect(mocks.toast.error).toHaveBeenCalledWith('remove — job is locked by a worker');
  });
});
