// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FleetConfig, FleetPlanes, FleetStatus, Machine, VerifyFinding } from '@/contract';

const scrollIntoView = vi.fn();
Element.prototype.scrollIntoView = scrollIntoView;

const { mocks, mutation } = vi.hoisted(() => ({
  mocks: {
    listMachines: vi.fn(),
    getStackState: vi.fn(),
    getFleetVerify: vi.fn(),
    getFleetBootReadiness: vi.fn(),
    getFleetConfig: vi.fn(),
  },
  mutation: () => ({ isPending: false, mutate: vi.fn(), reset: vi.fn(), variables: undefined }),
}));

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
  Link: ({ to, hash, children }: { to: string; hash?: string; children: ReactNode }) => (
    <a href={hash === undefined ? to : `${to}#${hash}`}>{children}</a>
  ),
}));
vi.mock('@/lib/api', () => ({
  tsr: {
    getMachineBootTrail: { useQuery: () => ({ data: undefined }) },
    listMachines: { useQuery: mocks.listMachines },
    getStackState: { useQuery: mocks.getStackState },
    getFleetVerify: { useQuery: mocks.getFleetVerify },
    getFleetBootReadiness: { useQuery: mocks.getFleetBootReadiness },
    getFleetConfig: { useQuery: mocks.getFleetConfig },
    powerMachine: { useMutation: mutation },
    resetMachine: { useMutation: mutation },
    healFleet: { useMutation: mutation },
    discoverMachine: { useMutation: mutation },
    controlDatastore: { useMutation: mutation },
    execMachine: { useMutation: mutation },
  },
}));
vi.mock('@/lib/use-log-stream', () => ({
  useLogStream: () => ({
    logHtml: '',
    logRef: { current: null },
    open: vi.fn(),
    clear: vi.fn(),
    follow: false,
    setFollow: vi.fn(),
    degraded: false,
    disconnected: false,
  }),
  awaitFleetRun: () => Promise.resolve(),
}));
vi.mock('@/lib/use-ops', () => ({
  OPS_POLL_MS: 5000,
  useOps: () => ({
    opList: [],
    allOps: [{ id: 'fleet-up', group: 'bringup' }],
    opsData: undefined,
    opsError: undefined,
    runList: [],
    activeOp: null,
    activeRun: null,
    isPending: false,
    gate: null,
    hostTokenDialog: null,
    onOpClick: vi.fn(),
  }),
}));
vi.mock('@/lib/apply-run', () => ({
  useApplyPending: () => ({ apply: vi.fn(), isPending: false, hostTokenDialog: null }),
}));
vi.mock('@/lib/use-apply-confirm', () => ({ useApplyConfirm: () => ({ confirmApply: vi.fn() }) }));
vi.mock('@/lib/use-host-token', () => ({ useHostToken: () => ({ dialog: null }) }));
vi.mock('@/lib/toast', () => ({ useToast: () => ({ ok: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/lib/use-poll', () => ({ usePoll: () => false as const }));
vi.mock('@/features/runtime', () => ({ ZoneRuntimeSection: () => null }));
vi.mock('@/components/fleet-status', () => ({ FleetStatusCard: () => null }));
vi.mock('@/components/pending-banner', () => ({ PendingBanner: () => null }));
vi.mock('@/components/terminal', () => ({ VmConsole: () => null }));
vi.mock('@/components/console', () => ({
  AnsiLogPane: () => null,
  DatastoreCard: () => null,
  GateModal: () => null,
  OpList: () => null,
  RecentRuns: () => null,
  SectionHeading: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  SvcBtn: ({ label }: { label: string }) => <button>{label}</button>,
}));

import { FleetPage, planeCopy } from './fleet';

const fleetStatus = (over: Partial<FleetStatus> = {}): FleetStatus => ({
  health: 'stopped',
  phase: null,
  step: null,
  label: null,
  node: null,
  index: 0,
  total: 0,
  stepOrdinal: -1,
  stepCount: 9,
  elapsedSec: null,
  machinesExpected: 0,
  machinesRunning: 0,
  accel: null,
  accelForced: null,
  detail: 'stopped',
  ...over,
});

const VM_ONLY: FleetPlanes = { vm: true, baremetal: false };
const BM_ONLY: FleetPlanes = { vm: false, baremetal: true };
const BOTH: FleetPlanes = { vm: true, baremetal: true };

const fleetConfig = (planes: FleetPlanes): FleetConfig => ({
  source: 'local',
  planes,
  baremetal: { nics: [], arch: 'amd64', nodes: [] },
  bakedChainUrl: null,
  nodes: [],
  zones: ['local'],
  network: {
    name: 'brokkr-net',
    cidr: '192.168.200.0/24',
    bmcCidr: '192.168.105.0/24',
    domain: 'sim.local',
    dhcp: false,
    renderedNetplan: false,
  },
  tombstones: [],
  bmcDefaults: { username: 'admin', password: 'admin' },
  defaults: { cpus: 4, memory_mb: 8192, disk_gb: 60, arch: null },
});

function show(planes: FleetPlanes, machines: Machine[] = [], readiness: VerifyFinding[] = []) {
  mocks.listMachines.mockReturnValue({ data: { status: 200, body: machines }, refetch: vi.fn() });
  mocks.getStackState.mockReturnValue({
    data: { status: 200, body: { fleetProcesses: [], fleet: fleetStatus() } },
    refetch: vi.fn(),
  });
  mocks.getFleetVerify.mockReturnValue({ data: { status: 200, body: { findings: [] } }, refetch: vi.fn() });
  mocks.getFleetBootReadiness.mockReturnValue({
    data: { status: 200, body: { findings: readiness } },
    refetch: vi.fn(),
  });
  mocks.getFleetConfig.mockReturnValue({ data: { status: 200, body: fleetConfig(planes) } });
  render(<FleetPage />);
}

function verifyCard(): HTMLDetailsElement {
  const el = document.querySelector<HTMLDetailsElement>('#fleet-verify details');
  if (!el) throw new Error('no #fleet-verify details rendered');
  return el;
}

const BM_1: Machine = { name: 'bm-1', kind: 'baremetal', power: 'on', configured: true, deviceId: 'dev-1', bmc: null };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('planeCopy', () => {
  it('names both planes when both rosters carry rows', () => {
    const copy = planeCopy(BOTH);
    expect(copy.hardware).toBe(
      'The simulated hardware (libvirt VMs + vbmc + sushy). Real machines PXE-booted from this stack (DHCP proxy + BMC power over Redfish).',
    );
  });

  it('names one plane when only one roster carries rows', () => {
    expect(planeCopy(VM_ONLY).hardware).toBe('The simulated hardware (libvirt VMs + vbmc + sushy).');
    expect(planeCopy(BM_ONLY).hardware).toBe(
      'Real machines PXE-booted from this stack (DHCP proxy + BMC power over Redfish).',
    );
    expect(planeCopy(VM_ONLY).noMachines).toBe('no machines (fleet down?)');
  });
});

describe('Fleet page subtitle', () => {
  it('describes the libvirt simulation when only the vm plane is on', () => {
    show(VM_ONLY);
    expect(screen.getByText(/The simulated hardware \(libvirt VMs \+ vbmc \+ sushy\)/)).toBeDefined();
    expect(screen.queryByText(/Real machines PXE-booted/)).toBeNull();
  });

  it('describes the pxe boot path when only the bare-metal plane is on', () => {
    show(BM_ONLY);
    expect(screen.getByText(/Real machines PXE-booted from this stack/)).toBeDefined();
    expect(screen.queryByText(/libvirt VMs \+ vbmc \+ sushy/)).toBeNull();
  });

  it('describes both when both planes are on', () => {
    show(BOTH);
    expect(screen.getByText(/libvirt VMs \+ vbmc \+ sushy.*Real machines PXE-booted from this stack/)).toBeDefined();
  });
});

describe('Fleet page empty machine list', () => {
  it('keeps the fleet-down question when only the vm plane is on', () => {
    show(VM_ONLY);
    expect(screen.getByText('no machines (fleet down?)')).toBeDefined();
  });

  it('names the pxe mac requirement and links to the fleet nodes page when the bare-metal plane is on', () => {
    show(BM_ONLY);
    expect(screen.getByText(/a bare-metal machine is listed once it carries a PXE MAC/)).toBeDefined();
    const link = screen.getByText('Fleet nodes');
    expect(link.getAttribute('href')).toBe('/config/fleet');
  });

  it('never asks the fleet-down question when the bare-metal plane is on', () => {
    show(BM_ONLY);
    expect(screen.queryByText(/fleet down\?/)).toBeNull();
  });

  it('renders the roster instead of an empty state when bare-metal machines exist', () => {
    show(BM_ONLY, [{ name: 'bm-1', kind: 'baremetal', power: 'on', configured: true, deviceId: 'dev-1', bmc: null }]);
    expect(screen.getByText('bm-1')).toBeDefined();
    expect(screen.queryByText(/a bare-metal machine is listed once it carries a PXE MAC/)).toBeNull();
    expect(screen.queryByText('no machines (fleet down?)')).toBeNull();
  });
});

describe('Fleet page boot-readiness findings', () => {
  it('renders a boot-readiness finding even when the verify report is clean', () => {
    show(
      BM_ONLY,
      [],
      [
        {
          node: null,
          kind: 'boot-readiness',
          healable: false,
          code: 'PXE-102',
          detail: 'PXE-102 (error): This prefix serves no DHCP.',
        },
      ],
    );

    expect(screen.getByText(/PXE-102 \(error\): This prefix serves no DHCP\./)).toBeDefined();
    expect(verifyCard().open).toBe(false);
  });

  it('lists a listed machine finding in the card and opens it from the chip', () => {
    show(
      BM_ONLY,
      [BM_1],
      [
        {
          node: 'bm-1',
          kind: 'boot-readiness',
          healable: false,
          code: 'PXE-106',
          detail: 'PXE-106 (warning): No DHCP lease seen for aa:bb:cc:dd:ee:ff.',
        },
      ],
    );

    const card = verifyCard();
    expect(within(card).getByText(/PXE-106 \(warning\): No DHCP lease seen/)).toBeDefined();
    expect(card.open).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '1 verify finding for bm-1, show' }));

    expect(card.open).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });
});
