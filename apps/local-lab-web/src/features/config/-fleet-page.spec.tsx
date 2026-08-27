// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FleetConfig, FleetNodeEffective } from '@/contract';

const { lab } = vi.hoisted(() => ({
  lab: {
    requestedZone: undefined as string | undefined,
    cfg: undefined as { status: number; body: unknown } | undefined,
    plan: undefined as { status: number; body: unknown } | undefined,
    put: undefined as { body: unknown } | undefined,
    putOpts: undefined as { onSuccess?: (r: { body: unknown }) => void } | undefined,
    previewBody: undefined as unknown,
    previewOpts: undefined as { onError?: (e: unknown) => void } | undefined,
    previewPending: false,
    toastErrors: [] as string[],
  },
}));

vi.mock('@/lib/api', () => ({
  tsr: {
    getFleetConfig: { useQuery: () => ({ data: lab.cfg, dataUpdatedAt: 1, refetch: () => Promise.resolve() }) },
    getHost: {
      useQuery: () => ({
        data: { status: 200, body: { os: 'linux', arch: 'amd64', passthroughSupported: true } },
      }),
    },
    listPci: { useQuery: () => ({ data: { status: 200, body: [] } }) },
    listHostNics: {
      useQuery: () => ({ data: { status: 200, body: [{ name: 'eth9', ipv4: '198.51.100.31/24', up: true }] } }),
    },
    listStackRuns: { useQuery: () => ({ data: { status: 200, body: [] }, refetch: () => Promise.resolve() }) },
    getRun: { useQuery: () => ({ data: undefined, dataUpdatedAt: 0 }) },
    putFleetConfig: {
      useMutation: () => ({
        isPending: false,
        submittedAt: 0,
        data: undefined,
        mutate: (v: { body: unknown }, opts?: typeof lab.putOpts) => {
          lab.put = v;
          lab.putOpts = opts;
        },
      }),
    },
    previewFleetApplyPlan: {
      useMutation: () => ({
        isPending: lab.previewPending,
        data: lab.plan,
        mutate: (v: { body: unknown }, opts?: { onError?: (e: unknown) => void }) => {
          lab.previewBody = v.body;
          lab.previewOpts = opts;
        },
      }),
    },
    startStackRun: { useMutation: () => ({ isPending: false, mutate: () => {} }) },
    baremetalPower: { useMutation: () => ({ isPending: false, mutate: () => {} }) },
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle', proceed: () => {}, reset: () => {} }),
  useSearch: () => lab.requestedZone,
}));
vi.mock('@/lib/toast', () => ({
  useToast: () => ({
    ok: () => {},
    error: (m: string) => {
      lab.toastErrors.push(m);
    },
    info: () => {},
  }),
}));
vi.mock('@/lib/apply-run', () => ({
  useApplyPending: () => ({ apply: () => Promise.resolve(), launchRun: () => {}, isPending: false }),
}));
vi.mock('@/lib/pending', () => ({ saveToastMessage: () => 'saved' }));
vi.mock('@/components/config/section-rail', () => ({
  SectionRail: () => null,
  scrollToSection: () => {},
}));
vi.mock('@/components/manifest-viewer', () => ({ ManifestViewer: () => null }));
vi.mock('@/components/pending-banner', () => ({ PendingBanner: () => null }));

import { ConfigFleetPage } from './fleet-page';

function fleetConfig(): FleetConfig {
  return {
    source: 'local',
    mode: 'vm',
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
  };
}

function vmNode(name: string, zone: string): FleetNodeEffective {
  return {
    name,
    zone,
    ipmi_mac: '52:54:00:bc:00:01',
    data_mac: '52:54:00:da:00:01',
    cpus: 4,
    memory_mb: 8192,
    disk_gb: 60,
    arch: null,
    network_type: null,
    disks: [],
    passthrough: [],
    nics: [],
    data_mtu: null,
    ip: null,
    bmc_ip: null,
    bmc: null,
    effective_ip: null,
    effective_bmc_ip: null,
    effective_cpus: 4,
    effective_memory_mb: 8192,
    effective_disk_gb: 60,
  };
}

function inheritingNode(name: string, zone: string): FleetNodeEffective {
  return { ...vmNode(name, zone), cpus: null, memory_mb: null, disk_gb: null };
}

function nodeCard(name: string): HTMLElement {
  const card = screen.getByDisplayValue(name).closest('div.rounded-lg');
  if (!card) throw new Error(`no node card for ${name}`);
  return card as HTMLElement;
}

function openVmFleet(nodes: FleetNodeEffective[]): void {
  lab.cfg = { status: 200, body: { ...fleetConfig(), nodes } };
  render(<ConfigFleetPage />);
}

function openFleet(over: Partial<FleetConfig> = {}, nodes: FleetNodeEffective[] = []): void {
  lab.cfg = { status: 200, body: { ...fleetConfig(), nodes, ...over } };
  render(<ConfigFleetPage />);
}

const savedBody = (): Record<string, unknown> => {
  fireEvent.click(screen.getByText('Save config'));
  const body = (lab.put as { body: Record<string, unknown> } | undefined)?.body;
  if (!body) throw new Error('nothing was submitted');
  return body;
};

function openBareMetal(): ReturnType<typeof render> {
  lab.cfg = { status: 200, body: fleetConfig() };
  const view = render(<ConfigFleetPage />);
  fireEvent.click(screen.getByText('Bare metal fleet'));
  return view;
}

function serverRefetch(view: ReturnType<typeof render>): void {
  lab.cfg = { status: 200, body: fleetConfig() };
  view.rerender(<ConfigFleetPage />);
}

beforeEach(() => {
  lab.cfg = undefined;
  lab.plan = undefined;
  lab.put = undefined;
  lab.putOpts = undefined;
  lab.previewBody = undefined;
  lab.previewOpts = undefined;
  lab.previewPending = false;
  lab.toastErrors = [];
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ConfigFleetPage — the VM node grid', () => {
  function filterNodes(value: string): void {
    fireEvent.change(screen.getByLabelText('Filter VMs by name or zone'), { target: { value } });
  }

  it('reports how many of the fleet the grid is showing', () => {
    openVmFleet([vmNode('cpu-1', 'sim-zone1'), vmNode('gpu-1', 'sim-zone1')]);

    expect(screen.getByText('2 of 2 VMs')).toBeTruthy();
  });

  it('narrows the grid to the VMs matching a name substring', () => {
    openVmFleet([vmNode('cpu-1', 'sim-zone1'), vmNode('gpu-1', 'sim-zone1')]);

    filterNodes('gpu');

    expect(screen.getByDisplayValue('gpu-1')).toBeTruthy();
    expect(screen.queryByDisplayValue('cpu-1')).toBeNull();
  });

  it('matches on the zone too', () => {
    openVmFleet([vmNode('cpu-1', 'sim-zone1'), vmNode('gpu-1', 'sim-zone2')]);

    filterNodes('zone2');

    expect(screen.getByDisplayValue('gpu-1')).toBeTruthy();
    expect(screen.queryByDisplayValue('cpu-1')).toBeNull();
  });

  it('edits the filtered VM rather than the one at that screen position', () => {
    openVmFleet([vmNode('cpu-1', 'sim-zone1'), vmNode('gpu-1', 'sim-zone1')]);

    filterNodes('gpu');
    fireEvent.change(screen.getByDisplayValue('gpu-1'), { target: { value: 'gpu-9' } });
    filterNodes('');

    expect(screen.getByDisplayValue('gpu-9')).toBeTruthy();
    expect(screen.getByDisplayValue('cpu-1')).toBeTruthy();
  });

  it('says so when nothing matches', () => {
    openVmFleet([vmNode('cpu-1', 'sim-zone1')]);

    filterNodes('nothing-matches-this');

    expect(screen.getByText('no VM matches the filter')).toBeTruthy();
  });

  it('collapses one VM to a summary without touching its sibling', () => {
    openVmFleet([vmNode('cpu-1', 'sim-zone1'), vmNode('gpu-1', 'sim-zone1')]);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle cpu-1' }));

    expect(screen.getByText('4 vCPU · 8192 MiB · 60 GB · 0 extra disks · 192.168.200.10')).toBeTruthy();
    expect(screen.getAllByText('PCI passthrough')).toHaveLength(1);
  });

  it('shows what an inheriting node actually gets, and says it is inherited', () => {
    openVmFleet([inheritingNode('cpu-1', 'local')]);
    const card = nodeCard('cpu-1');

    expect(within(card).getAllByText('inherited').length).toBe(3);
    expect(within(card).getByDisplayValue('4')).toBeTruthy();
    expect(within(card).getByDisplayValue('8192')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'inherit' })).toBeNull();
  });

  it('re-derives an inheriting node when the fleet default changes in the same session', () => {
    openVmFleet([inheritingNode('cpu-1', 'local')]);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle cpu-1' }));
    expect(screen.getByText(/^4 vCPU · 8192 MiB · 60 GB/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('vCPUs'), { target: { value: '16' } });

    expect(screen.getByText(/^16 vCPU · 8192 MiB · 60 GB/)).toBeTruthy();
  });

  it('leaves a node that pins its own value alone when the fleet default changes', () => {
    openVmFleet([vmNode('cpu-1', 'local')]);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle cpu-1' }));

    fireEvent.change(screen.getByLabelText('vCPUs'), { target: { value: '16' } });

    expect(screen.getByText(/^4 vCPU · 8192 MiB · 60 GB/)).toBeTruthy();
  });

  it('offers a way back to the fleet default once a node pins its own value', () => {
    openVmFleet([vmNode('cpu-1', 'local')]);
    const card = nodeCard('cpu-1');

    expect(within(card).getAllByRole('button', { name: 'inherit' }).length).toBe(3);
    expect(within(card).queryByText('inherited')).toBeNull();
  });

  it('expands it again', () => {
    openVmFleet([vmNode('cpu-1', 'sim-zone1')]);

    fireEvent.click(screen.getByRole('button', { name: 'Toggle cpu-1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle cpu-1' }));

    expect(screen.getAllByText('PCI passthrough')).toHaveLength(1);
    expect(screen.queryByText('4 vCPU · 8192 MiB · 60 GB · 0 extra disks · 192.168.200.10')).toBeNull();
  });
});

describe('ConfigFleetPage — the network section', () => {
  it('exposes every plane field, not just the two cidrs', () => {
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.getByDisplayValue('brokkr-net')).toBeTruthy();
    expect(screen.getByDisplayValue('sim.local')).toBeTruthy();
    expect(screen.getByDisplayValue('192.168.200.0/24')).toBeTruthy();
    expect(screen.getByDisplayValue('192.168.105.0/24')).toBeTruthy();
  });

  it('carries an edited plane field into the saved body', () => {
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    fireEvent.change(screen.getByDisplayValue('sim.local'), { target: { value: 'lab.local' } });

    expect(savedBody().network).toMatchObject({ domain: 'lab.local' });
  });

  it('disables rendered netplan on a multi-zone fleet and names the reason', () => {
    openFleet({}, [vmNode('cpu-1', 'sim-zone'), vmNode('gpu-1', 'edge')]);

    expect(screen.getByLabelText(/rendered netplan/i)).toHaveProperty('disabled', true);
    expect(screen.getByText(/2 zones share one cidr/)).toBeTruthy();
  });

  it('disables rendered netplan while dhcp is on, because the engine refuses the pair', () => {
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    fireEvent.click(screen.getByLabelText(/^dhcp$/i));

    expect(screen.getByLabelText(/rendered netplan/i)).toHaveProperty('disabled', true);
    expect(screen.getByText(/dhcp is on/)).toBeTruthy();
  });

  it('leaves rendered netplan editable on a single-zone fleet with dhcp off', () => {
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.getByLabelText(/rendered netplan/i)).toHaveProperty('disabled', false);
  });
});

describe('ConfigFleetPage — removed nodes', () => {
  const overlayOnly = { name: 'cpu-3', zone: 'sim-zone', baseDeclared: false };
  const stillDeclared = { name: 'cpu-4', zone: 'sim-zone', baseDeclared: true };

  it('renders no section at all when the overlay carries no tombstone', () => {
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.queryByText(/^▸ Removed/)).toBeNull();
  });

  it('lists a tombstone the overlay alone declares with a way to drop it', () => {
    openFleet({ tombstones: [overlayOnly] }, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.getByText('cpu-3')).toBeTruthy();
    expect(screen.getByTitle(/drop this tombstone on save/)).toBeTruthy();
  });

  it('offers no drop for a node the base still declares, and says why', () => {
    openFleet({ tombstones: [stillDeclared] }, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.queryByTitle(/drop this tombstone on save/)).toBeNull();
    expect(screen.getByText(/the base still declares it/)).toBeTruthy();
  });

  it('sends a selected drop in the prune list', () => {
    openFleet({ tombstones: [overlayOnly] }, [vmNode('cpu-1', 'sim-zone')]);

    fireEvent.click(screen.getByTitle(/drop this tombstone on save/));

    expect(savedBody().prune).toEqual(['cpu-3']);
  });

  it('omits prune entirely when nothing is selected', () => {
    openFleet({ tombstones: [overlayOnly] }, [vmNode('cpu-1', 'sim-zone')]);

    fireEvent.change(screen.getByDisplayValue('sim.local'), { target: { value: 'lab.local' } });

    expect(savedBody().prune).toBeUndefined();
  });
});

describe('ConfigFleetPage — the pre-save cost', () => {
  it('states nothing about cost until a draft is classified', () => {
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.queryByText(/applying costs about/)).toBeNull();
  });

  it('shows the total once the plan arrives', () => {
    lab.plan = {
      status: 200,
      body: { fallbackFullRebuild: false, reason: null, dataLoss: false, etaSec: 120, items: [] },
    };
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.getByText(/applying costs about 2m/)).toBeTruthy();
  });

  it('puts the per-node verdict on the card the plan names', () => {
    lab.plan = {
      status: 200,
      body: {
        fallbackFullRebuild: false,
        reason: null,
        dataLoss: true,
        etaSec: 10,
        items: [
          {
            name: 'cpu-1',
            action: 'node-disk',
            reason: 'disk_gb changed',
            fields: ['disk_gb'],
            etaSec: 10,
            dataLoss: true,
          },
        ],
      },
    };
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.getByText(/node-disk/)).toBeTruthy();
    expect(screen.getByText(/wipes this disk/)).toBeTruthy();
  });

  it('says nothing on a node the plan reports as a noop', () => {
    lab.plan = {
      status: 200,
      body: {
        fallbackFullRebuild: false,
        reason: null,
        dataLoss: false,
        etaSec: 0,
        items: [{ name: 'cpu-1', action: 'noop', reason: 'unchanged', fields: [], etaSec: 0, dataLoss: false }],
      },
    };
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.queryByText(/applying:/)).toBeNull();
  });
});

describe('ConfigFleetPage — the arch default', () => {
  it('reads as the host until a default is set', () => {
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.getByLabelText('arch')).toHaveProperty('value', '');
  });

  it('carries a chosen arch into the saved defaults', () => {
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    fireEvent.change(screen.getByLabelText('arch'), { target: { value: 'arm64' } });

    expect(savedBody().defaults).toMatchObject({ arch: 'arm64' });
  });
});

describe('ConfigFleetPage — a fleet-config refetch while the operator edits', () => {
  it('leaves the selected bare-metal mode in place', () => {
    const view = openBareMetal();
    expect(screen.getByText('Uplink NIC')).toBeTruthy();

    serverRefetch(view);

    expect(screen.getByText('Uplink NIC')).toBeTruthy();
  });

  it('keeps a half-filled machine row', () => {
    const view = openBareMetal();
    fireEvent.click(screen.getByRole('button', { name: '+ Add server' }));
    fireEvent.change(screen.getByDisplayValue('metal-1'), { target: { value: 'rack-7' } });

    serverRefetch(view);

    expect(screen.getByDisplayValue('rack-7')).toBeTruthy();
  });

  it('keeps the selected uplink NIC', () => {
    const view = openBareMetal();
    fireEvent.change(screen.getByDisplayValue('— select a NIC —'), { target: { value: 'eth9' } });

    serverRefetch(view);

    expect(screen.getByDisplayValue('eth9 — 198.51.100.31/24')).toBeTruthy();
  });

  it('still hydrates from the server before any edit', () => {
    lab.cfg = { status: 200, body: { ...fleetConfig(), mode: 'baremetal' } };
    render(<ConfigFleetPage />);

    expect(screen.getByText('Uplink NIC')).toBeTruthy();
  });
});

describe('ConfigFleetPage — the fleet editor names the file it writes', () => {
  it('tells the operator the save target is stack.local.nix', () => {
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);

    expect(screen.getByText('stack.local.nix')).toBeTruthy();
  });

  it('surfaces a toast when the draft classification is refused', () => {
    openVmFleet([vmNode('cpu-1', 'sim-zone')]);

    fireEvent.click(screen.getByRole('button', { name: /cost of this change/i }));
    lab.previewOpts?.onError?.(new Error('boom'));

    expect(lab.toastErrors.join(' ')).toMatch(/could not classify this draft/i);
  });

  it('refuses a second classification while one is still in flight, and says so', () => {
    lab.previewPending = true;
    openVmFleet([vmNode('cpu-1', 'sim-zone')]);

    const button = screen.getByTitle(/classify this draft/i);
    expect(button).toHaveProperty('disabled', true);
    expect(button.textContent).toMatch(/checking/i);
  });
});

describe('ConfigFleetPage — a node card states its zone cost and can be linked to', () => {
  it('names the fleet-wide rebuild a zone change causes, not just this VM', () => {
    openVmFleet([vmNode('cpu-1', 'sim-zone')]);

    const select = screen.getByTitle(/identity change/i);

    expect(select.title).toMatch(/every VM/i);
  });

  it('anchors the card on the node name so a zone can link to it', () => {
    openVmFleet([vmNode('cpu-1', 'sim-zone')]);

    expect(document.getElementById('node-cpu-1')).not.toBeNull();
  });
});

describe('ConfigFleetPage — the overlay it names is the one it writes', () => {
  it('names stack.local.nix, not the retired fleet.local.yml', () => {
    render(<ConfigFleetPage />);

    expect(screen.getByText(/stack\.local\.nix/)).toBeTruthy();
    expect(screen.queryByText(/fleet\.local\.yml/)).toBeNull();
  });
});

describe('ConfigFleetPage — a zone can hand over which zone to add into', () => {
  it('adds the node into the zone the link named, not the first declared one', () => {
    lab.requestedZone = 'edge-zone';
    openFleet({ zones: ['local', 'edge-zone'] }, []);

    fireEvent.click(screen.getByText('+ Add VM'));

    expect(screen.getByDisplayValue('edge-zone')).toBeTruthy();
  });

  it('falls back to the first declared zone when no link named one', () => {
    lab.requestedZone = undefined;
    openFleet({ zones: ['local', 'edge-zone'] }, []);

    fireEvent.click(screen.getByText('+ Add VM'));

    expect(screen.getByDisplayValue('local')).toBeTruthy();
  });
});

describe('ConfigFleetPage — the node grid is grouped by zone', () => {
  it('heads each declared zone with the VMs it holds', () => {
    openFleet({ zones: ['local', 'edge-zone'] }, [vmNode('cpu-1', 'local')]);

    expect(screen.getByText('1 VM')).toBeTruthy();
    expect(screen.getByText('no VMs yet')).toBeTruthy();
  });

  it('flags a zone nothing declares rather than hiding its VMs', () => {
    openFleet({ zones: ['local'] }, [vmNode('orphan-1', 'gone-zone')]);

    expect(screen.getByText(/no zone declares this/)).toBeTruthy();
    expect(screen.getByDisplayValue('orphan-1')).toBeTruthy();
  });
});

describe('ConfigFleetPage — a filtered zone is not an empty zone', () => {
  it('keeps the real total in the heading when the filter hides some of a zone', () => {
    openFleet({ zones: ['local'] }, [vmNode('cpu-1', 'local'), vmNode('gpu-1', 'local')]);

    fireEvent.change(screen.getByLabelText('Filter VMs by name or zone'), { target: { value: 'cpu' } });

    expect(screen.getByText('1 of 2 shown')).toBeTruthy();
    expect(screen.queryByText('no VMs yet')).toBeNull();
  });

  it('says a zone is hidden by the filter rather than reporting it holds nothing', () => {
    openFleet({ zones: ['local', 'edge-zone'] }, [vmNode('cpu-1', 'local'), vmNode('gpu-1', 'edge-zone')]);

    fireEvent.change(screen.getByLabelText('Filter VMs by name or zone'), { target: { value: 'cpu' } });

    expect(screen.getByText('every VM here is hidden by the filter')).toBeTruthy();
    expect(screen.queryByText('no VMs yet')).toBeNull();
  });
});

describe('ConfigFleetPage — a save the overlay only partly wrote', () => {
  function saveThenServerSays(rejected: unknown[]): void {
    openFleet({}, [vmNode('cpu-1', 'sim-zone')]);
    fireEvent.change(screen.getByDisplayValue('sim.local'), { target: { value: 'lab.local' } });
    fireEvent.click(screen.getByText('Save config'));
    act(() => {
      lab.putOpts?.onSuccess?.({ body: { ok: true, pending: null, rejected } });
    });
  }

  it('names a pinned fleet.mode rather than answering a bare ok', () => {
    saveThenServerSays([{ path: 'fleet.mode', reason: 'pinned', detail: 'BROKKR_FLEET_MODE' }]);

    expect(screen.getByText('Not written:')).toBeTruthy();
    expect(screen.getByText('fleet.mode — pinned (BROKKR_FLEET_MODE)')).toBeTruthy();
  });

  it('names a removed node the overlay kept as a tombstone', () => {
    saveThenServerSays([{ path: 'fleet.nodes.cpu-3', reason: 'tombstoned' }]);

    expect(screen.getByText('fleet.nodes.cpu-3 — tombstoned')).toBeTruthy();
  });

  it('shows nothing when the whole request landed', () => {
    saveThenServerSays([]);

    expect(screen.queryByText('Not written:')).toBeNull();
  });
});
