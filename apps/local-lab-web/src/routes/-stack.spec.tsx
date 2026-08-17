// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FleetStatus, Service, StackOp } from '@/contract';
import { streamPaths } from '@/contract';
import type { StackSearch } from '@/lib/stack-search';

const mocks = vi.hoisted(() => ({
  stackState: vi.fn(),
  services: vi.fn(),
  initTasks: vi.fn(),
  ops: vi.fn(),
  open: vi.fn(),
  useSearch: vi.fn<() => StackSearch>(() => ({ init: undefined })),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  createFileRoute: () => () => ({ useSearch: mocks.useSearch }),
}));
vi.mock('@/lib/api', () => ({
  tsr: {
    getStackState: { useQuery: mocks.stackState },
    listServices: { useQuery: mocks.services },
    getInitTasks: { useQuery: mocks.initTasks },
    controlService: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
    controlDatastore: { useMutation: () => ({ mutate: vi.fn(), isPending: false }) },
  },
}));
vi.mock('@/lib/use-ops', () => ({ OPS_POLL_MS: 30_000, useOps: mocks.ops }));
vi.mock('@/lib/use-log-stream', () => ({
  usePaintedHtml: () => ({ current: null }),
  useLogStream: () => ({
    logHtml: '',
    logRef: { current: null },
    open: mocks.open,
    clear: vi.fn(),
    follow: true,
    setFollow: vi.fn(),
    degraded: false,
    disconnected: false,
  }),
}));
vi.mock('@/lib/toast', () => ({ useToast: () => ({ error: vi.fn(), success: vi.fn() }) }));
vi.mock('@/lib/use-apply-confirm', () => ({
  useApplyConfirm: () => ({ confirmApply: vi.fn(), applyConfirm: null }),
}));
vi.mock('@/features/runtime', () => ({ ZoneRuntimeTiles: () => <div>zone runtime tiles</div> }));
vi.mock('@/components/process-env', () => ({ ProcessEnvPane: () => <div>env pane</div> }));

import { StackPage } from './stack';

const svc = (over: Partial<Service> = {}): Service =>
  ({
    id: 'hub-api',
    label: 'Hub API',
    group: 'hub',
    port: 3000,
    health: 'up',
    running: true,
    canStop: true,
    ...over,
  }) as Service;

const fleet = (over: Partial<FleetStatus> = {}): FleetStatus =>
  ({ health: 'ready', detail: '4 VMs running', ...over }) as FleetStatus;

const op = (over: Partial<StackOp> = {}): StackOp => ({
  id: 'reconcile',
  label: 'Reconcile',
  task: 'stack-reconcile',
  description: 'self-heals the control plane',
  section: 'stack',
  group: 'bringup',
  destructive: false,
  needsSudo: false,
  ...over,
});

const opsResult = (over: Record<string, unknown> = {}) => ({
  opList: [op()],
  allOps: [op()],
  opsData: { status: 200, body: [op()] },
  opsError: null,
  runList: [],
  runningOpIds: new Set<string>(),
  activeOp: null,
  activeRun: null,
  isPending: false,
  sudoReady: true,
  gate: null,
  onOpClick: vi.fn(),
  cancelRun: vi.fn(),
  ...over,
});

const setup = (over: { fleet?: FleetStatus | undefined; ops?: Record<string, unknown> } = {}) => {
  const hasFleet = 'fleet' in over ? over.fleet : fleet();
  mocks.stackState.mockReturnValue({
    data: {
      status: 200,
      body: { datastores: [], datastoresUp: true, fleet: hasFleet, fleetPending: null },
    },
    refetch: vi.fn(),
  });
  mocks.services.mockReturnValue({ data: { status: 200, body: [svc()] }, refetch: vi.fn() });
  mocks.initTasks.mockReturnValue({ data: { status: 200, body: [] }, refetch: vi.fn() });
  mocks.ops.mockReturnValue(opsResult(over.ops));
  return render(<StackPage />);
};

describe('StackPage fleet summary row', () => {
  beforeEach(() => {
    mocks.stackState.mockReset();
    mocks.services.mockReset();
    mocks.initTasks.mockReset();
    mocks.ops.mockReset();
    mocks.open.mockClear();
    mocks.useSearch.mockReturnValue({ init: undefined });
  });
  afterEach(cleanup);

  it('renders the fleet row in the summary column above the service groups', () => {
    const { container } = setup();
    const text = container.textContent ?? '';

    expect(screen.getByText('Fleet')).toBeTruthy();
    expect(text.indexOf('Fleet')).toBeLessThan(text.indexOf('Hub API'));
  });

  it('places the fleet row inside the status block, not the services block', () => {
    const { container } = setup();
    const status = container.querySelector('[data-tour="stack-status"]');

    expect(status?.textContent).toContain('Fleet');
    expect(status?.textContent).toContain('4 VMs running');
  });

  it('lines the fleet dot up with the init strip dot by reserving the chevron slot', () => {
    mocks.stackState.mockReset();
    mocks.services.mockReset();
    mocks.initTasks.mockReset();
    mocks.ops.mockReset();
    mocks.stackState.mockReturnValue({
      data: { status: 200, body: { datastores: [], datastoresUp: true, fleet: fleet(), fleetPending: null } },
      refetch: vi.fn(),
    });
    mocks.services.mockReturnValue({ data: { status: 200, body: [svc()] }, refetch: vi.fn() });
    mocks.initTasks.mockReturnValue({
      data: {
        status: 200,
        body: [{ name: 'hub:init', label: 'Hub build', state: 'completed', exitCode: 0, detail: null, updatedAt: 1 }],
      },
      refetch: vi.fn(),
    });
    mocks.ops.mockReturnValue(opsResult());
    const { container } = render(<StackPage />);
    const status = container.querySelector('[data-tour="stack-status"]');
    const leads = status?.querySelectorAll('span.w-2.text-left') ?? [];

    expect(leads.length).toBe(2);
    expect(leads[0].textContent).toBe('›');
    expect(leads[1].textContent).toBe('');
  });

  it('hides the fleet row when the state carries no fleet', () => {
    setup({ fleet: undefined });

    expect(screen.queryByText('Fleet')).toBeNull();
  });
});

describe('StackPage op registry failure', () => {
  beforeEach(() => {
    mocks.stackState.mockReset();
    mocks.services.mockReset();
    mocks.initTasks.mockReset();
    mocks.ops.mockReset();
    mocks.open.mockClear();
    mocks.useSearch.mockReturnValue({ init: undefined });
  });
  afterEach(cleanup);

  it('says why every op section is empty when the registry query failed', () => {
    setup({ ops: { opList: [], allOps: [], opsData: undefined, opsError: new Error('Failed to fetch') } });

    expect(screen.getByText(/op list unavailable/)).toBeTruthy();
    expect(screen.getByText(/Failed to fetch/)).toBeTruthy();
    expect(screen.getByText(/retrying every 30s/)).toBeTruthy();
  });

  it('stays quiet for a registry that legitimately answered with no ops', () => {
    setup({ ops: { opList: [], allOps: [], opsData: { status: 200, body: [] }, opsError: null } });

    expect(screen.queryByText(/op list unavailable/)).toBeNull();
  });

  it('stays quiet while the registry still has ops to show', () => {
    setup({ ops: { opsData: undefined, opsError: new Error('Failed to fetch') } });

    expect(screen.queryByText(/op list unavailable/)).toBeNull();
  });

  it('honours an empty-string server message as an explicit suppression', () => {
    setup({ ops: { opList: [], allOps: [], opsData: { status: 500, body: { error: '' } }, opsError: null } });

    expect(screen.queryByText(/op list unavailable/)).toBeNull();
  });
});

describe('StackPage deep-linked init log', () => {
  beforeEach(() => {
    mocks.stackState.mockReset();
    mocks.services.mockReset();
    mocks.initTasks.mockReset();
    mocks.ops.mockReset();
    mocks.open.mockClear();
    mocks.useSearch.mockReturnValue({ init: 'sim:seed' });
  });
  afterEach(cleanup);

  it('opens the init log the url names on arrival', () => {
    setup();

    expect(mocks.open).toHaveBeenCalledWith(streamPaths.stackInitLog('sim:seed'), { finite: false });
  });
});
