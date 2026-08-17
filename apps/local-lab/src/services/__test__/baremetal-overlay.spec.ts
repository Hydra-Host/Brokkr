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
    lan: { expose: boolean };
    telemetry: { enable: boolean };
    stackDefaults: { hub: Record<string, string>; spoke: Record<string, string>; hubKnobEnv: Record<string, string[]> };
    portKeys: { editable: string[]; readOnly: string[] };
    ports: Record<string, number>;
    portDefaults: Record<string, number>;
    observabilityPorts: Record<string, number>;
    bridges: unknown[];
    fleet: unknown;
    fleetOwned: boolean;
    mode: 'vm' | 'baremetal';
    baremetal: { nics: string[]; arch: string; nodes: Record<string, Record<string, unknown>> } | null;
    baremetalOwned: boolean;
    zonesMeta: { name: string; index: number; bridges: number }[];
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
    identity: { pg: { user: 'u', password: 'p', db: 'd' }, orgId: 'org' },
    osLayerCache: { originHost: '', resolvers: '' },
    lan: { expose: false },
    telemetry: { enable: false },
    stackDefaults: { hub: {}, spoke: {}, hubKnobEnv: {} },
    portKeys: { editable: [], readOnly: [] },
    ports: {},
    portDefaults: {},
    observabilityPorts: {},
    bridges: [],
    fleet: null,
    fleetOwned: false,
    mode: 'vm',
    baremetal: null,
    baremetalOwned: false,
    zonesMeta: [{ name: 'sim-zone', index: 0, bridges: 1 }],
  };
  return { svc, overlay: () => readFileSync(t.overlayPath(), 'utf8') };
}

afterEach(() => vi.unstubAllEnvs());

describe('OverlayStoreService.setFleetConfig — bare-metal overlay', () => {
  it('a vm-mode save emits neither fleet.mode nor fleet.baremetal (byte-identity)', () => {
    const { svc, overlay } = makeService();
    svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: { cpus: 2 } }], mode: 'vm' });
    const out = overlay();
    expect(out).not.toMatch(/fleet\.mode/);
    expect(out).not.toMatch(/fleet\.baremetal/);
    expect(out).toMatch(/fleet\.zones\."sim-zone"\.nodes\."cpu-1"/);
  });

  it('a baremetal-mode save emits fleet.mode + fleet.baremetal.* (iface/ifaceIp/arch/nodes)', () => {
    const { svc, overlay } = makeService();
    svc.setFleetConfig({
      nodes: [],
      mode: 'baremetal',
      baremetal: {
        nics: ['enp35s0'],
        arch: 'amd64',
        nodes: [
          {
            name: 'metal-1',
            spec: { bmc_ip: '192.168.1.50', bmc_mac: 'aa:bb:cc:dd:ee:01', pxe_mac: 'aa:bb:cc:dd:ee:02' },
          },
        ],
      },
    });
    const out = overlay();
    expect(out).toMatch(/fleet\.mode = "baremetal";/);
    expect(out).toMatch(/fleet\.baremetal\.iface = "enp35s0";/);
    expect(out).toMatch(/fleet\.baremetal\.ifaceIp = ".*";/);
    expect(out).toMatch(/fleet\.baremetal\.arch = "amd64";/);
    expect(out).toMatch(/fleet\.baremetal\.nodes\."metal-1"/);
    expect(out).toMatch(/"bmc_ip" = "192\.168\.1\.50";/);
  });

  it('a vm-only save preserves a previously-saved baremetal section', () => {
    const { svc, overlay } = makeService();
    svc.setFleetConfig({
      nodes: [],
      mode: 'baremetal',
      baremetal: { nics: ['enp35s0'], arch: 'amd64', nodes: [{ name: 'metal-1', spec: { bmc_ip: '10.0.0.1' } }] },
    });
    svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: { cpus: 4 } }], mode: 'vm' });
    const out = overlay();
    expect(out).not.toMatch(/fleet\.mode/);
    expect(out).toMatch(/fleet\.baremetal\.nodes\."metal-1"/);
    expect(out).toMatch(/fleet\.zones\."sim-zone"\.nodes\."cpu-1"/);
  });
});
