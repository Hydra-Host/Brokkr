// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FleetStatus, Run, Service, Status } from '@/contract';

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  getInitTasks: vi.fn(),
  listStacks: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  createFileRoute: () => () => ({}),
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => mocks.navigate,
}));
vi.mock('@/lib/api', () => ({
  tsr: {
    getStatus: { useQuery: mocks.getStatus },
    getInitTasks: { useQuery: mocks.getInitTasks },
    listStacks: { useQuery: mocks.listStacks },
  },
}));

import { DashboardPage } from '@/features/dashboard/dashboard-page';

const run = (over: Partial<Run> = {}): Run => ({
  runId: 'r1',
  section: 'test',
  opId: 'vitest',
  label: 'vitest e2e',
  status: 'passed',
  startedAt: 1_000,
  finishedAt: 2_000,
  exitCode: 0,
  nodeIndex: null,
  origin: null,
  hasLog: true,
  hasResult: false,
  ...over,
});

const service = (over: Partial<Service> = {}): Service => ({
  id: 'hub-api',
  label: 'Hub API',
  group: 'hub',
  zone: null,
  port: 3000,
  running: true,
  ready: true,
  pid: 1,
  health: 'up',
  canStop: true,
  ...over,
});

const status = (over: Partial<Status> = {}): Status => ({
  app: {
    pid: 1,
    startedAt: 1_000_000,
    uptimeSec: 100,
    memlockLimit: 'unlimited',
    distBuiltAt: 1,
    stale: false,
    ccBuild: { sha: '9fbcfdcde1234', builtAt: 1_500_000, headSha: '9fbcfdcde1234', stale: false },
  },
  repos: {
    lab: { path: '/x', branch: 'main', commit: 'aaa', dirty: false },
    hub: { path: '/x', branch: 'main', commit: 'aaa', dirty: false },
    spoke: { path: '/x', branch: 'main', commit: 'aaa', dirty: false },
  },
  services: [service(), service({ id: 'spoke', label: 'Spoke', group: 'spoke', zone: 'z1', port: 8000 })],
  datastores: { postgres: true, redis: true },
  stack: { counts: { hub: 1, spoke: 1 }, lifecycleWorkerConcurrency: 4 },
  fleet: [],
  ...over,
});

const fleetHealth = (over: Partial<FleetStatus> = {}): FleetStatus => ({
  health: 'ready',
  phase: 'supervising',
  step: 'ready',
  label: null,
  node: null,
  index: 0,
  total: 0,
  stepOrdinal: 8,
  stepCount: 9,
  elapsedSec: null,
  machinesExpected: 4,
  machinesRunning: 4,
  detail: 'ready · 4/4 VMs running',
  ...over,
});

const answer = (body: Status | undefined) =>
  mocks.getStatus.mockReturnValue({ data: body === undefined ? undefined : { status: 200, body } });

beforeEach(() => {
  mocks.getStatus.mockReset();
  mocks.getInitTasks.mockReset();
  mocks.navigate.mockClear();
  mocks.getInitTasks.mockReturnValue({ data: { status: 200, body: [] } });
  mocks.listStacks.mockReturnValue({
    data: {
      status: 200,
      body: {
        stacks: [
          {
            slot: 0,
            checkout: '/work/boss',
            state: 'up',
            live: true,
            hubUrl: 'http://localhost:3000',
            webUrl: 'http://localhost:5173',
            labUrl: 'http://localhost:3002',
            labWebUrl: 'http://localhost:5175',
            processes: { running: 12, total: 14 },
            healthLine: null,
          },
        ],
        selfSlot: 0,
      },
    },
  });
});

afterEach(cleanup);

describe('DashboardPage', () => {
  it('waits for the first answer instead of spinner-storming widgets', () => {
    answer(undefined);

    render(<DashboardPage />);

    expect(screen.getByText(/waiting for the control-center API/)).toBeTruthy();
  });

  it('reports a failing status query instead of waiting for it forever', () => {
    mocks.getStatus.mockReturnValue({ data: { status: 500, body: { error: 'fleet config invalid: cpu-1' } } });

    render(<DashboardPage />);

    expect(screen.getByText(/fleet config invalid: cpu-1/)).toBeTruthy();
    expect(screen.queryByText(/waiting for the control-center API/)).toBeNull();
  });

  it('honours an empty-string status error as explicit suppression, not a blank page', () => {
    mocks.getStatus.mockReturnValue({ data: { status: 500, body: { error: '' } } });

    const { container } = render(<DashboardPage />);

    expect(container.querySelector('[class*="border-status-offline"]')).toBeNull();
    expect(screen.getByText(/waiting for the control-center API/)).toBeTruthy();
  });

  it('renders the pipeline hero and the footer once the snapshot lands', () => {
    answer(status());

    const { container } = render(<DashboardPage />);
    const hero = container.querySelector<HTMLElement>('[data-tour="overview-hero"]');
    if (!hero) throw new Error('overview hero not rendered');

    expect(screen.getByText('datastores')).toBeTruthy();
    expect(within(hero).getByText('hub')).toBeTruthy();
    expect(screen.getByText('spoke')).toBeTruthy();
    expect(screen.getByText(/cc 9fbcfdc/)).toBeTruthy();
  });

  it('links a failed control plane at the stack page', () => {
    answer(status({ datastores: { postgres: false, redis: true } }));

    render(<DashboardPage />);

    expect(screen.getByText('open Stack →').closest('a')?.getAttribute('href')).toBe('/stack');
  });

  it('maps each recent run to the page that owns its section', () => {
    answer(
      status({
        recentRuns: [run(), run({ runId: 'r2', section: 'fleet', label: 'fleet-apply · n4' })],
      }),
    );

    render(<DashboardPage />);

    expect(screen.getByText('vitest e2e').closest('a')?.getAttribute('href')).toBe('/results');
    expect(screen.getByText('fleet-apply · n4').closest('a')?.getAttribute('href')).toBe('/fleet');
  });

  it('degrades absent fields to omitted panels, not placeholders', () => {
    answer(status());

    render(<DashboardPage />);

    expect(screen.getByText('no fleet nodes')).toBeTruthy();
    expect(screen.getByText('run ledger unreadable')).toBeTruthy();
    expect(screen.queryByText(/last test:/)).toBeNull();
    expect(screen.queryByText(/Init DAG/)).toBeNull();
  });

  it('tells an unreadable run ledger apart from an empty one', () => {
    answer(status({ recentRuns: [] }));
    const empty = render(<DashboardPage />);
    expect(screen.getByText('no runs recorded yet')).toBeTruthy();
    empty.unmount();

    answer(status());
    render(<DashboardPage />);
    expect(screen.getByText('run ledger unreadable')).toBeTruthy();
    expect(screen.queryByText('no runs recorded yet')).toBeNull();
  });

  it('polls the roster fast and expands it while init needs attention', () => {
    answer(status({ initStatus: { state: 'running', total: 10, completed: 4, failed: 0, current: 'Sim seed' } }));
    mocks.getInitTasks.mockReturnValue({
      data: {
        status: 200,
        body: [{ name: 'sim:seed', label: 'Sim seed', state: 'running', exitCode: null, detail: null, updatedAt: 1 }],
      },
    });

    render(<DashboardPage />);

    expect(mocks.getInitTasks).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, refetchInterval: 3_000 }));
    expect(screen.getByText(/Init DAG/)).toBeTruthy();
    expect(screen.getByText('Sim seed')).toBeTruthy();
  });

  it('deep-links an init task at the stack page log that owns it', () => {
    answer(status({ initStatus: { state: 'running', total: 1, completed: 0, failed: 0, current: 'Sim seed' } }));
    mocks.getInitTasks.mockReturnValue({
      data: {
        status: 200,
        body: [{ name: 'sim:seed', label: 'Sim seed', state: 'running', exitCode: null, detail: null, updatedAt: 1 }],
      },
    });

    render(<DashboardPage />);
    fireEvent.click(screen.getByText('Sim seed'));

    expect(mocks.navigate).toHaveBeenCalledWith({ to: '/stack', search: { init: 'sim:seed' } });
  });

  it('keeps a settled roster on the page, collapsed, at a slower cadence', () => {
    answer(status({ initStatus: { state: 'completed', total: 1, completed: 1, failed: 0, current: null } }));
    mocks.getInitTasks.mockReturnValue({
      data: {
        status: 200,
        body: [{ name: 'sim:seed', label: 'Sim seed', state: 'completed', exitCode: 0, detail: null, updatedAt: 1 }],
      },
    });

    render(<DashboardPage />);

    expect(mocks.getInitTasks).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, refetchInterval: 30_000 }),
    );
    expect(screen.getByText(/Init DAG/)).toBeTruthy();
    expect(screen.queryByText('Sim seed')).toBeNull();
  });

  it('reports the init aggregate when the roster itself cannot be read', () => {
    answer(status({ initStatus: { state: 'failed', total: 9, completed: 4, failed: 1, current: 'Sim seed' } }));
    mocks.getInitTasks.mockReturnValue({ data: undefined, isPending: false });

    render(<DashboardPage />);

    expect(screen.getByText(/Sim seed · 4\/9 completed/)).toBeTruthy();
  });

  it('withholds the roster-unreadable fallback while the init query is still in flight', () => {
    answer(status({ initStatus: { state: 'failed', total: 9, completed: 4, failed: 1, current: 'Sim seed' } }));
    mocks.getInitTasks.mockReturnValue({ data: undefined, isPending: true });

    render(<DashboardPage />);

    expect(screen.queryByText(/Init DAG/)).toBeNull();
  });

  it('reports the fleet health and machine counts once the composed status lands', () => {
    answer(status({ fleetHealth: fleetHealth() }));

    render(<DashboardPage />);

    expect(screen.getByText('4/4 VMs on')).toBeTruthy();
    expect(screen.queryByText(/ready · 4\/4 VMs running/)).toBeNull();
  });

  it('distinguishes fleet-health VM counts from the fleet-summary rollup when both are present', () => {
    answer(
      status({
        fleet: [
          { name: 'cpu-1', power: 'on', lifecycleStatus: null, deviceId: null, gpuModel: null },
          { name: 'cpu-2', power: 'off', lifecycleStatus: null, deviceId: null, gpuModel: null },
        ],
        fleetSummary: { total: 6, on: 3, off: 2, unknown: 1, byLifecycle: { provisioning: 2 } },
        fleetHealth: fleetHealth(),
      }),
    );

    render(<DashboardPage />);

    expect(screen.getByText('4/4 VMs on')).toBeTruthy();
    expect(screen.getByText(/3\/6 on/)).toBeTruthy();
  });

  it('shows the bring-up step chips only while the fleet is coming up', () => {
    answer(
      status({
        fleetHealth: fleetHealth({
          health: 'coming-up',
          step: 'build-ipxe',
          stepOrdinal: 4,
          node: 'cpu-3',
          index: 3,
          total: 4,
          machinesRunning: 0,
          detail: 'building per-VM iPXE binary for cpu-3',
        }),
      }),
    );

    render(<DashboardPage />);

    expect(screen.getByText('iPXE')).toBeTruthy();
    expect(screen.getByText('cpu-3 · 3/4')).toBeTruthy();
  });

  it('shows no progress bar for a settled fleet', () => {
    answer(status({ fleetHealth: fleetHealth() }));

    render(<DashboardPage />);

    expect(screen.queryByText('iPXE')).toBeNull();
  });

  it('falls back to the node chips when no fleet is configured', () => {
    answer(status({ fleetHealth: fleetHealth({ machinesExpected: 0, machinesRunning: 0, health: 'idle' }) }));

    render(<DashboardPage />);

    expect(screen.getByText('no fleet nodes')).toBeTruthy();
    expect(screen.queryByText('0/0 on')).toBeNull();
  });
});
