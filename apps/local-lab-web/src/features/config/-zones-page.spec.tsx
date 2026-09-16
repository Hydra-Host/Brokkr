// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ZonesConfig } from '@/contract';

const { lab } = vi.hoisted(() => ({
  lab: {
    cfg: undefined as { status: number; body: unknown } | undefined,
    fleet: undefined as { status: number; body: unknown } | undefined,
    putBody: undefined as unknown,
    putOptions: undefined as { onSuccess?: (r: { body: unknown }) => void; onError?: (e: unknown) => void } | undefined,
  },
}));

vi.mock('@tanstack/react-router', () => ({
  useBlocker: () => ({ status: 'idle', proceed: () => {}, reset: () => {} }),
  useNavigate: () => () => {},
  Link: ({
    children,
    to,
    hash,
    ...rest
  }: {
    children?: unknown;
    to?: unknown;
    hash?: unknown;
    [key: string]: unknown;
  }) => {
    const label = typeof rest.title === 'string' ? rest.title : undefined;
    const href = `${typeof to === 'string' ? to : ''}${typeof hash === 'string' ? `#${hash}` : ''}`;
    return createElement('a', { href, title: label }, children as never);
  },
}));
vi.mock('@/lib/api', () => ({
  tsr: {
    getZonesConfig: { useQuery: () => ({ data: lab.cfg, error: undefined, refetch: () => Promise.resolve() }) },
    getFleetConfig: { useQuery: () => ({ data: lab.fleet, isPending: false }) },
    listMachines: { useQuery: () => ({ data: undefined, isPending: false }) },
    listZoneRuntimes: { useQuery: () => ({ data: undefined, isPending: false }) },
    putZonesConfig: {
      useMutation: () => ({
        isPending: false,
        mutate: (vars: { body: unknown }, opts: typeof lab.putOptions) => {
          lab.putBody = vars.body;
          lab.putOptions = opts;
        },
      }),
    },
  },
}));
vi.mock('@/features/runtime', () => ({
  useZoneRuntime: () => ({ zones: [], error: null, isPending: false }),
  ZoneRuntimeCard: () => null,
}));
vi.mock('@/components/config/section-rail', () => ({
  SectionRail: () => null,
  scrollToSection: () => {},
}));

import { ConfigZonesPage } from './zones-page';

const zone = (over: Record<string, unknown> = {}) => ({
  name: 'sim-zone',
  index: 0,
  bridges: 1,
  baseDeclared: true,
  derived: {
    uuid: '00000000-0000-0000-0000-111111111111',
    ordinals: [0],
    bridges: [{ proc: 'spoke', port: 8000, grpc: 9082 }],
    nodeCount: 4,
  },
  ...over,
});

const config = (over: Partial<ZonesConfig> = {}): ZonesConfig =>
  ({
    seeded: true,
    zones: [zone()],
    capacity: { used: 1, total: 25 },
    reservedNames: ['sim-zone-maintenance'],
    reconcile: [],
    hubReadError: null,
    ...over,
  }) as ZonesConfig;

const open = (over: Partial<ZonesConfig> = {}) => {
  lab.cfg = { status: 200, body: config(over) };
  render(<ConfigZonesPage />);
};

beforeEach(() => {
  cleanup();
  lab.cfg = undefined;
  lab.fleet = undefined;
  lab.putBody = undefined;
  lab.putOptions = undefined;
});

describe('ConfigZonesPage — what the overlay sets beside what nix derives', () => {
  it('shows the set values as editable and the derived ones as facts', () => {
    open();

    expect(screen.getByDisplayValue('sim-zone')).toBeTruthy();
    expect(screen.getByText('00000000-0000-0000-0000-111111111111')).toBeTruthy();
    expect(screen.getAllByText(/spoke :8000\/:9082/).length).toBeGreaterThan(0);
  });

  it('says a declared zone is not seeded yet rather than showing an empty runtime', () => {
    open();

    expect(screen.getByText(/declared, not seeded/)).toBeTruthy();
  });
});

describe('ConfigZonesPage — saving', () => {
  it('sends the whole desired set, because a zone absent from it is removed', () => {
    open({
      zones: [zone(), zone({ name: 'edge', index: 1, bridges: 2 })],
    });

    fireEvent.click(screen.getByText('+ Add zone'));
    fireEvent.click(screen.getByRole('button', { name: 'Save zones' }));

    expect((lab.putBody as { zones: unknown[] }).zones).toHaveLength(3);
  });

  it('names a single edited name as a rename rather than a new zone', () => {
    open();

    fireEvent.change(screen.getByDisplayValue('sim-zone'), { target: { value: 'edge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save zones' }));

    expect(lab.putBody).toMatchObject({ rename: { from: 'sim-zone', to: 'edge' } });
  });

  it('sends no rename when two names changed, because the set cannot express two', () => {
    open({ zones: [zone(), zone({ name: 'edge', index: 1, bridges: 1 })] });

    fireEvent.change(screen.getByDisplayValue('sim-zone'), { target: { value: 'a' } });
    fireEvent.change(screen.getByDisplayValue('edge'), { target: { value: 'b' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save zones' }));

    expect((lab.putBody as { rename?: unknown }).rename).toBeUndefined();
  });

  it('treats a newly added zone as new rather than as a rename', () => {
    open();

    fireEvent.click(screen.getByText('+ Add zone'));
    fireEvent.click(screen.getByRole('button', { name: 'Save zones' }));

    expect((lab.putBody as { rename?: unknown }).rename).toBeUndefined();
  });

  it('warns that a rename keeps the index, so the hub row stays put', () => {
    open();

    fireEvent.change(screen.getByDisplayValue('sim-zone'), { target: { value: 'edge' } });

    expect(screen.getByText(/the index stays/)).toBeTruthy();
  });

  it('refuses to save while the seed has failed', () => {
    open({ seeded: false });

    fireEvent.change(screen.getByDisplayValue('sim-zone'), { target: { value: 'edge' } });
    fireEvent.click(screen.getByRole('button', { name: /Save zones|Saved/ }));

    expect(lab.putBody).toBeUndefined();
  });

  it('surfaces the refusal the server gave rather than a generic message', () => {
    open();

    fireEvent.change(screen.getByDisplayValue('sim-zone'), { target: { value: 'edge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save zones' }));
    act(() => {
      lab.putOptions?.onError?.({ body: { error: 'duplicate zone index: 1' } });
    });

    expect(screen.getByText('duplicate zone index: 1')).toBeTruthy();
  });

  it('offers no removal for the last zone', () => {
    open();

    expect(screen.getByRole('button', { name: 'remove' })).toHaveProperty('disabled', true);
  });

  it('allows removing one of two', () => {
    open({ zones: [zone(), zone({ name: 'edge', index: 1, bridges: 1 })] });

    expect(screen.getAllByRole('button', { name: 'remove' })[0]).toHaveProperty('disabled', false);
  });
});

describe('ConfigZonesPage — the ordered plan lives on the shared panel', () => {
  it('carries no plan strip of its own, so a refresh cannot lose it', () => {
    open();
    fireEvent.change(screen.getByDisplayValue('sim-zone'), { target: { value: 'edge' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save zones' }));

    act(() => {
      lab.putOptions?.onSuccess?.({
        body: {
          ok: true,
          plan: {
            fullRebuild: false,
            steps: [{ id: 'sim:seed', label: 'Re-seed the hub', why: 'the Zone row upserts by id' }],
          },
        },
      });
    });

    expect(screen.queryByText(/Run these in order/)).toBeNull();
  });

  it('names what a rename will cost before the save, which the panel cannot answer', () => {
    open();

    fireEvent.change(screen.getByDisplayValue('sim-zone'), { target: { value: 'edge' } });

    expect(screen.getByText(/re-derives its acl password/)).toBeTruthy();
  });
});

describe('ConfigZonesPage — reconcile', () => {
  it('says both sides agree rather than showing an empty list', () => {
    open();

    expect(screen.getByText(/declare the same zones/)).toBeTruthy();
  });

  it('labels the seeded fixture instead of reporting it as drift', () => {
    open({
      reconcile: [{ name: 'sim-zone-maintenance', zoneId: 'zf', side: 'hub-only', fixture: true }],
    });

    expect(screen.getByText(/seeded for admin ops/)).toBeTruthy();
    expect(screen.queryByText(/no fleet zone declares it/)).toBeNull();
  });

  it('flags a genuine hub-only zone as drift', () => {
    open({ reconcile: [{ name: 'stray', zoneId: 'zx', side: 'hub-only', fixture: false }] });

    expect(screen.getByText(/no fleet zone declares it/)).toBeTruthy();
  });

  it('flags a declared zone the hub has not seeded', () => {
    open({ reconcile: [{ name: 'edge', zoneId: null, side: 'fleet-only', fixture: false }] });

    expect(screen.getByText(/the hub has not seeded it/)).toBeTruthy();
  });

  it('says an unreadable hub is not a measurement, so an empty list is not agreement', () => {
    open({ reconcile: [], hubReadError: 'connection refused' });

    expect(screen.getByText(/could not be read/)).toBeTruthy();
    expect(screen.queryByText(/declare the same zones/)).toBeNull();
  });
});

describe('ConfigZonesPage — the zone says which nodes it holds', () => {
  const withNode = () => {
    lab.fleet = {
      status: 200,
      body: {
        nodes: [
          {
            name: 'cpu-1',
            zone: 'sim-zone',
            cpus: 4,
            memory_mb: 8192,
            disk_gb: 40,
            arch: null,
            network_type: null,
            ip: null,
            bmc_ip: null,
            bmc: null,
            disks: [],
            passthrough: [],
            nics: [],
            data_mtu: null,
            ipmi_mac: '52:54:00:00:00:01',
            data_mac: '52:54:00:00:01:01',
            effective_ip: null,
            effective_bmc_ip: null,
            effective_cpus: 4,
            effective_memory_mb: 8192,
            effective_disk_gb: 40,
          },
        ],
        baremetal: { nics: [], arch: 'amd64', nodes: [] },
      },
    };
  };

  const linkFor = (name: string) =>
    screen
      .getAllByText(name)
      .map((el) => el.closest('a'))
      .find((a) => a !== null) ?? null;

  const withBareMetal = () => {
    lab.fleet = {
      status: 200,
      body: {
        nodes: [],
        baremetal: {
          nics: ['enp0'],
          arch: 'amd64',
          nodes: [
            {
              name: 'metal-1',
              bmc_ip: '192.168.1.50',
              bmc_mac: '3c:ec:ef:00:00:01',
              pxe_mac: '3c:ec:ef:00:00:02',
              arch: null,
              zone: 'sim-zone',
              system_id: null,
              network_type: null,
            },
          ],
        },
      },
    };
  };

  it('draws the fleet above the zone cards', () => {
    open();

    expect(screen.getByLabelText(/Fleet topology/)).toBeTruthy();
  });

  it('names the nodes a zone holds instead of only counting them', () => {
    withNode();
    open();

    expect(screen.getAllByText('cpu-1').length).toBeGreaterThan(0);
    expect(linkFor('cpu-1')?.getAttribute('href')).toBe('/config/fleet#node-cpu-1');
  });

  it("names a saved bare-metal machine among the zone's nodes and links it to the bare-metal section", () => {
    withBareMetal();
    open();

    expect(screen.getAllByText('metal-1').length).toBeGreaterThan(0);
    expect(linkFor('metal-1')?.getAttribute('href')).toBe('/config/fleet#BAREMETAL');
  });

  it('offers a path from the zone to adding a node already in it', () => {
    open();

    expect(screen.getByTitle('add a node already assigned to sim-zone')).toBeTruthy();
  });
});

describe('ConfigZonesPage — the apply bar header', () => {
  it('counts every changed row rather than reporting the dirty flag as one', () => {
    open({ zones: [zone(), zone({ name: 'edge', index: 1, bridges: 1 })] });

    fireEvent.change(screen.getByDisplayValue('sim-zone'), { target: { value: 'a' } });
    fireEvent.change(screen.getByDisplayValue('edge'), { target: { value: 'b' } });
    fireEvent.click(screen.getByText('+ Add zone'));

    expect(screen.getByText(/3 unsaved/)).toBeTruthy();
  });

  it('counts a removed zone, which is work the save still has to write', () => {
    open({ zones: [zone(), zone({ name: 'edge', index: 1, bridges: 1 })] });

    fireEvent.click(screen.getAllByRole('button', { name: 'remove' })[1]);

    expect(screen.getByText(/1 unsaved/)).toBeTruthy();
  });

  it('reports nothing unsaved on an untouched set', () => {
    open();

    expect(screen.queryByText(/unsaved/)).toBeNull();
  });
});
