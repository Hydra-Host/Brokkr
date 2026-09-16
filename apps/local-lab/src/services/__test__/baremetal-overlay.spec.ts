import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OverlayStoreService } from '../overlay-store';
import type { ProcessComposeClient } from '../process-compose.client';
import { RenderedConfigService } from '../rendered-config.service';

type Internals = {
  mirror: {
    seeded: boolean;
    hub: Record<string, string>;
    spoke: Record<string, string>;
    counts: { hub: number; spoke: number };
    identity: unknown;
    osLayerCache: { originHost: string; resolvers: string };
    lan: { mode: string; bindAddress: string; publicHost: string; datastoreAuth: boolean; expose: boolean };
    telemetry: { enable: boolean };
    stackDefaults: { hub: Record<string, string>; spoke: Record<string, string>; hubKnobEnv: Record<string, string[]> };
    portKeys: { editable: string[]; readOnly: string[] };
    ports: Record<string, number>;
    portDefaults: Record<string, number>;
    observabilityPorts: Record<string, number>;
    bridges: unknown[];
    fleet: unknown;
    fleetOwned: boolean;
    baremetal: { nics: string[]; arch: string; nodes: Record<string, Record<string, unknown>> } | null;
    baremetalOwned: boolean;
    zonesMeta: { name: string; index: number; bridges: number }[];
    catalog: unknown[];
    zoneCapacity: number;
    zoneFiles: Record<string, string[]>;
    zoneTombstones: string[];
    options: Record<string, string | number | boolean>;
  } | null;
  overlayPath(): string;
};

function makeService(): { svc: OverlayStoreService; overlay: () => string } {
  const pc = {} as unknown as ProcessComposeClient;
  const root = mkdtempSync(join(tmpdir(), 'lab-bm-'));
  vi.stubEnv('DEVENV_ROOT', root);
  const svc = new OverlayStoreService(new RenderedConfigService(pc));
  const t = svc as unknown as Internals;
  t.mirror = {
    seeded: true,
    hub: {},
    spoke: {},
    counts: { hub: 1, spoke: 1 },
    identity: {
      pg: { user: 'u', password: 'p', db: 'd' },
      orgId: 'org',
      redis: { password: 'p' },
      mailpit: { password: 'p' },
    },
    osLayerCache: { originHost: '', resolvers: '' },
    lan: { mode: 'loopback', bindAddress: '', publicHost: '', datastoreAuth: true, expose: false },
    telemetry: { enable: false },
    stackDefaults: { hub: {}, spoke: {}, hubKnobEnv: {} },
    portKeys: { editable: [], readOnly: [] },
    ports: {},
    portDefaults: {},
    observabilityPorts: {},
    bridges: [],
    fleet: null,
    fleetOwned: false,
    baremetal: null,
    baremetalOwned: false,
    zonesMeta: [{ name: 'sim-zone', index: 0, bridges: 1 }],
    catalog: [],
    zoneCapacity: 25,
    zoneFiles: {},
    zoneTombstones: [],
    options: {},
  };
  return { svc, overlay: () => readFileSync(t.overlayPath(), 'utf8') };
}

afterEach(() => vi.unstubAllEnvs());

const METAL_1 = {
  name: 'metal-1',
  spec: { bmc_ip: '192.168.1.50', bmc_mac: 'aa:bb:cc:dd:ee:01', pxe_mac: 'aa:bb:cc:dd:ee:02' },
};

describe('OverlayStoreService.setFleetConfig — bare-metal overlay', () => {
  it('a vm-only save emits no fleet.baremetal section (byte-identity)', () => {
    const { svc, overlay } = makeService();
    svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: { cpus: 2 } }] });
    const out = overlay();
    expect(out).not.toMatch(/fleet\.baremetal/);
    expect(out).toMatch(/fleet\.zones\."sim-zone"\.nodes\."cpu-1"/);
  });

  it('a bare-metal save emits fleet.baremetal.* (iface/ifaceIp/arch/nodes)', () => {
    const { svc, overlay } = makeService();
    svc.setFleetConfig({ nodes: [], baremetal: { nics: ['enp35s0'], arch: 'amd64', nodes: [METAL_1] } });
    const out = overlay();
    expect(out).toMatch(/fleet\.baremetal\.iface = "enp35s0";/);
    expect(out).toMatch(/fleet\.baremetal\.ifaceIp = ".*";/);
    expect(out).toMatch(/fleet\.baremetal\.arch = "amd64";/);
    expect(out).toMatch(/fleet\.baremetal\.nodes\."metal-1"/);
    expect(out).toMatch(/"bmc_ip" = "192\.168\.1\.50";/);
  });

  it('emits no fleet mode line for any roster', () => {
    const { svc, overlay } = makeService();
    svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: { cpus: 2 } }] });
    expect(overlay()).not.toMatch(/fleet\.mode/);
    svc.setFleetConfig({ nodes: [], baremetal: { nics: ['enp35s0'], arch: 'amd64', nodes: [METAL_1] } });
    expect(overlay()).not.toMatch(/fleet\.mode/);
    svc.setFleetConfig({
      nodes: [{ name: 'cpu-1', spec: { cpus: 2 } }],
      baremetal: { nics: ['enp35s0'], arch: 'amd64', nodes: [METAL_1] },
    });
    expect(overlay()).not.toMatch(/fleet\.mode/);
  });

  it('a vm-only save preserves a previously-saved baremetal section', () => {
    const { svc, overlay } = makeService();
    svc.setFleetConfig({
      nodes: [],
      baremetal: { nics: ['enp35s0'], arch: 'amd64', nodes: [{ name: 'metal-1', spec: { bmc_ip: '10.0.0.1' } }] },
    });
    svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: { cpus: 4 } }] });
    const out = overlay();
    expect(out).toMatch(/fleet\.baremetal\.nodes\."metal-1"/);
    expect(out).toMatch(/fleet\.zones\."sim-zone"\.nodes\."cpu-1"/);
  });

  it('derives the planes from the saved rosters after each save', () => {
    const { svc } = makeService();
    svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: { cpus: 2 } }] });
    expect(svc.planes()).toEqual({ vm: true, baremetal: false });
    svc.setFleetConfig({ nodes: [], baremetal: { nics: ['enp35s0'], arch: 'amd64', nodes: [METAL_1] } });
    expect(svc.planes()).toEqual({ vm: false, baremetal: true });
    svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: { cpus: 2 } }] });
    expect(svc.planes()).toEqual({ vm: true, baremetal: true });
    svc.setFleetConfig({ nodes: [], baremetal: { nics: ['enp35s0'], arch: 'amd64', nodes: [] } });
    expect(svc.planes()).toEqual({ vm: false, baremetal: false });
  });
});
