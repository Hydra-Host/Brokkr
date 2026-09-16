// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StackPending } from '@/contract';

const { lab } = vi.hoisted(() => ({
  lab: {
    pending: undefined as { status: number; body: unknown } | undefined,
    pendingErr: undefined as unknown,
    fleet: undefined as { status: number; body: unknown } | undefined,
    reloadGroups: [] as string[],
    reloadFails: undefined as unknown,
    redeployCalls: 0,
    opClicks: [] as string[],
    opIds: ['fleet-apply', 'fleet-planes-apply', 'reinit'],
    run: undefined as { status: number; body: unknown } | undefined,
  },
}));

vi.mock('@/lib/api', () => ({
  tsr: {
    getStackPending: {
      useQuery: () => ({ data: lab.pending, error: lab.pendingErr, refetch: () => Promise.resolve() }),
    },
    getFleetConfig: { useQuery: () => ({ data: lab.fleet, refetch: () => Promise.resolve() }) },
    reloadService: {
      useMutation: () => ({
        isPending: false,
        mutate: (
          v: { body: { group: string } },
          opts?: { onSuccess?: (r: { body: { runId: string } }) => void; onError?: (e: unknown) => void },
        ) => {
          lab.reloadGroups.push(v.body.group);
          if (lab.reloadFails) opts?.onError?.(lab.reloadFails);
          else opts?.onSuccess?.({ body: { runId: 'run-reload' } });
        },
      }),
    },
    redeployStack: {
      useMutation: () => ({
        isPending: false,
        mutate: (_v: unknown, opts?: { onSuccess?: (r: { body: { runId: string } }) => void }) => {
          lab.redeployCalls += 1;
          opts?.onSuccess?.({ body: { runId: 'run-redeploy' } });
        },
      }),
    },
    getRun: { useQuery: () => ({ data: lab.run }) },
  },
}));
vi.mock('@/lib/use-log-stream', () => ({
  useLogStream: () => ({ logRef: { current: null }, logHtml: '', logText: '', open: () => {} }),
  usePaintedHtml: () => ({ current: null }),
}));
vi.mock('@/lib/use-ops', () => ({
  useOps: () => ({
    allOps: lab.opIds.map((id) => ({ id, label: id, destructive: id !== 'fleet-apply', needsSudo: false, task: id })),
    onOpClick: (op: { id: string }) => lab.opClicks.push(op.id),
    gate: null,
    isPending: false,
  }),
}));
vi.mock('@/lib/use-apply-confirm', () => ({
  useApplyConfirm: () => ({ confirmApply: vi.fn(), prompt: vi.fn() }),
}));

import { ApplyPanel } from './apply-panel';

const pending = (over: Partial<StackPending> = {}): StackPending => ({
  seeded: true,
  savedNotApplied: { paths: [], classes: [] },
  strongestClass: null,
  rebindArmed: false,
  restart: { status: 'idle' },
  resetRequired: [],
  unknownSince: null,
  zoneSteps: [],
  ...over,
});

afterEach(cleanup);
beforeEach(() => {
  lab.pending = { status: 200, body: pending() };
  lab.pendingErr = undefined;
  lab.fleet = { status: 200, body: { pending: null } };
  lab.reloadGroups = [];
  lab.reloadFails = undefined;
  lab.redeployCalls = 0;
  lab.opClicks = [];
  lab.run = undefined;
});

describe('ApplyPanel — a read that failed is never a clean stack', () => {
  it('reports the read failure rather than rendering nothing', () => {
    lab.pendingErr = new Error('the endpoint is down');

    render(<ApplyPanel />);

    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(screen.getByText(/An empty panel here would be a guess/)).toBeTruthy();
  });

  it('reports a non-200 answer as a failure too, not as nothing pending', () => {
    lab.pending = { status: 503, body: {} };

    render(<ApplyPanel />);

    expect(screen.getByText(/answered 503/)).toBeTruthy();
  });

  it('says saving is refused when the seed failed', () => {
    lab.pending = { status: 200, body: pending({ seeded: false }) };

    render(<ApplyPanel />);

    expect(screen.getByText(/saving is refused/)).toBeTruthy();
  });

  it('renders nothing at all on a clean stack', () => {
    const { container } = render(<ApplyPanel />);

    expect(container.textContent).toBe('');
  });
});

describe('ApplyPanel — one button per outstanding row', () => {
  it('offers the hub reload for a hub path, and runs it', () => {
    lab.pending = {
      status: 200,
      body: pending({ savedNotApplied: { paths: ['stackDefaults.hub.LOG_LEVEL'], classes: ['reload-hub'] } }),
    };

    render(<ApplyPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(lab.reloadGroups).toEqual(['hub']);
  });

  it('offers the redeploy for a port path, which a reload cannot deliver', () => {
    lab.pending = {
      status: 200,
      body: pending({ savedNotApplied: { paths: ['ports.postgres'], classes: ['rebind-recreate'] } }),
    };

    render(<ApplyPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(lab.redeployCalls).toBe(1);
    expect(lab.reloadGroups).toEqual([]);
  });

  it('routes a datastore reset through the op gate rather than a bare run', () => {
    lab.pending = {
      status: 200,
      body: pending({
        savedNotApplied: { paths: ['identity.pg.user'], classes: ['datastore-reset'] },
        resetRequired: ['identity.pg.user'],
      }),
    };

    render(<ApplyPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));

    expect(lab.opClicks).toEqual(['reinit']);
  });

  it('renders no button at all for a path no rule owns', () => {
    lab.pending = { status: 200, body: pending({ savedNotApplied: { paths: ['nothing.owns.this'], classes: [] } }) };

    render(<ApplyPanel />);

    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText(/no action applies this/)).toBeTruthy();
  });

  it('names a failed recreation and offers nothing that would hide it', () => {
    lab.pending = { status: 200, body: pending({ restart: { status: 'failed' } }) };

    render(<ApplyPanel />);

    expect(screen.getByText(/recreation is failed/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('names a run that failed to start instead of reporting nothing', () => {
    lab.reloadFails = new Error('process-compose is not running');
    lab.pending = {
      status: 200,
      body: pending({ savedNotApplied: { paths: ['stackDefaults.hub.LOG_LEVEL'], classes: ['reload-hub'] } }),
    };

    render(<ApplyPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(screen.getByText(/process-compose is not running/)).toBeTruthy();
  });

  it('refuses a second run while the first is still in flight', () => {
    lab.pending = {
      status: 200,
      body: pending({ savedNotApplied: { paths: ['ports.postgres'], classes: ['rebind-recreate'] } }),
    };

    render(<ApplyPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    expect(lab.redeployCalls).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: /applying/ }));
    expect(lab.redeployCalls).toBe(1);
  });

  it('offers the fleet apply from the engine drift, on a page that is not the fleet page', () => {
    lab.fleet = {
      status: 200,
      body: {
        pending: {
          inSync: false,
          severity: 'hot-appliable',
          desiredDigest: 'a',
          appliedDigest: 'b',
          appliedAt: null,
          summary: { added: 1, removed: 0, changed: 0, unchanged: 2 },
          nodes: { added: [], removed: [], changed: [] },
          network: { changed: false },
          note: null,
        },
      },
    };

    render(<ApplyPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));

    expect(lab.opClicks).toEqual(['fleet-apply']);
  });
});
