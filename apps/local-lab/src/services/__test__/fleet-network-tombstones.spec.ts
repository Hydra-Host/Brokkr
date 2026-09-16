import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OverlayStoreService } from '../overlay-store';
import type { ProcessComposeClient } from '../process-compose.client';
import { RenderedConfigService } from '../rendered-config.service';

type Mirror = Record<string, unknown>;
type Internals = { mirror: Mirror | null; overlayPath(): string };

function makeService(over: Mirror = {}): { svc: OverlayStoreService; overlay: () => string } {
  const pc = {} as unknown as ProcessComposeClient;
  const root = mkdtempSync(join(tmpdir(), 'lab-fleet-net-'));
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
    catalog: [],
    provenance: [],
    values: [],
    envPins: {},
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
    zoneCapacity: 25,
    zoneFiles: {},
    zoneTombstones: [],
    options: {},
    fleetNodeFiles: {},
    ...over,
  };
  return { svc, overlay: () => readFileSync(t.overlayPath(), 'utf8') };
}

afterEach(() => vi.unstubAllEnvs());

describe('OverlayStoreService.setFleetConfig — the network block', () => {
  it('emits one line per leaf, so a sibling the base declares survives', () => {
    const { svc, overlay } = makeService();
    svc.setFleetConfig({
      nodes: [{ name: 'cpu-1', spec: {} }],
      network: {
        name: 'brokkr-net',
        cidr: '192.168.200.0/24',
        bmc_cidr: '192.168.105.0/24',
        domain: 'sim.local',
        dhcp: true,
        rendered_netplan: false,
      },
    });
    const out = overlay();
    expect(out).toMatch(/fleet\.network\.name = "brokkr-net";/);
    expect(out).toMatch(/fleet\.network\.cidr = "192\.168\.200\.0\/24";/);
    expect(out).toMatch(/fleet\.network\.bmc_cidr = "192\.168\.105\.0\/24";/);
    expect(out).toMatch(/fleet\.network\.domain = "sim\.local";/);
    expect(out).toMatch(/fleet\.network\.dhcp = true;/);
    expect(out).toMatch(/fleet\.network\.rendered_netplan = false;/);
    expect(out).not.toMatch(/fleet\.network = /);
  });

  it('leaves the persisted network untouched when a save omits it', () => {
    const { svc, overlay } = makeService({
      fleet: { network: { cidr: '10.9.0.0/24' }, defaults: {}, nodes: {} },
      fleetOwned: true,
    });
    svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: {} }] });
    expect(overlay()).toMatch(/fleet\.network\.cidr = "10\.9\.0\.0\/24";/);
  });

  it('emits defaults.arch as its own leaf beside the size defaults', () => {
    const { svc, overlay } = makeService();
    svc.setFleetConfig({
      nodes: [{ name: 'cpu-1', spec: {} }],
      defaults: { cpus: 4, memory_mb: null, disk_gb: null, arch: 'arm64' },
    });
    const out = overlay();
    expect(out).toMatch(/fleet\.defaults\.cpus = 4;/);
    expect(out).toMatch(/fleet\.defaults\.arch = "arm64";/);
    expect(out).not.toMatch(/fleet\.defaults\.memory_mb/);
  });

  it('clears defaults.arch when the save sends null', () => {
    const { svc, overlay } = makeService({
      fleet: { network: {}, defaults: { arch: 'arm64' }, nodes: {} },
      fleetOwned: true,
    });
    svc.setFleetConfig({
      nodes: [{ name: 'cpu-1', spec: {} }],
      defaults: { cpus: null, memory_mb: null, disk_gb: null, arch: null },
    });
    expect(overlay()).not.toMatch(/fleet\.defaults\.arch/);
  });
});

describe('OverlayStoreService — tombstones and pruning', () => {
  const withTombstone = (files: Record<string, Record<string, string[]>>) => ({
    fleet: {
      network: {},
      defaults: {},
      nodes: {
        'cpu-1': { zone: 'sim-zone', index: 0 },
        'cpu-3': { enable: false, zone: 'sim-zone' },
      },
    },
    fleetOwned: true,
    fleetNodeFiles: files,
  });

  it('reports a node another file still declares as base-declared', () => {
    const { svc } = makeService(
      withTombstone({ 'sim-zone': { 'cpu-3': ['stack.local.nix', 'devenv/modules/fleet-topology.nix'] } }),
    );
    expect(svc.fleetTombstones()).toEqual([{ name: 'cpu-3', zone: 'sim-zone', baseDeclared: true }]);
  });

  it('reports a node only the overlay declares as safe to prune', () => {
    const { svc } = makeService(withTombstone({ 'sim-zone': { 'cpu-3': ['stack.local.nix'] } }));
    expect(svc.fleetTombstones()).toEqual([{ name: 'cpu-3', zone: 'sim-zone', baseDeclared: false }]);
  });

  it('fails closed when the eval reported no file list at all', () => {
    const { svc } = makeService(withTombstone({}));
    expect(svc.fleetTombstones()[0].baseDeclared).toBe(true);
  });

  it('lists no tombstone for a node that is still enabled', () => {
    const { svc } = makeService(withTombstone({ 'sim-zone': { 'cpu-3': ['stack.local.nix'] } }));
    expect(svc.fleetTombstones().map((t) => t.name)).toEqual(['cpu-3']);
  });

  it('drops a pruned name instead of re-emitting its tombstone', () => {
    const { svc, overlay } = makeService(withTombstone({ 'sim-zone': { 'cpu-3': ['stack.local.nix'] } }));
    svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: {} }], prune: ['cpu-3'] });
    const out = overlay();
    expect(out).toMatch(/fleet\.zones\."sim-zone"\.nodes\."cpu-1"/);
    expect(out).not.toMatch(/cpu-3/);
  });

  it('keeps tombstoning a removed node the save did not prune', () => {
    const { svc, overlay } = makeService(withTombstone({ 'sim-zone': { 'cpu-3': ['stack.local.nix'] } }));
    svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: {} }] });
    expect(overlay()).toMatch(/fleet\.zones\."sim-zone"\.nodes\."cpu-3" = \{\s*"enable" = false;/);
  });
});

describe('OverlayStoreService.setFleetConfig — what the write did not persist', () => {
  const withNodes = () => ({
    fleet: {
      network: {},
      defaults: {},
      nodes: {
        'cpu-1': { zone: 'sim-zone', index: 0 },
        'cpu-3': { enable: false, zone: 'sim-zone' },
      },
    },
    fleetOwned: true,
  });

  it('reports a removed node the overlay held out as a tombstone instead of dropping', () => {
    const { svc } = makeService(withNodes());

    const rejected = svc.setFleetConfig({ nodes: [] });

    expect(rejected).toEqual([{ path: 'fleet.nodes.cpu-1', reason: 'tombstoned' }]);
  });

  it('stops re-reporting a node that was already tombstoned', () => {
    const { svc } = makeService(withNodes());

    expect(svc.setFleetConfig({ nodes: [{ name: 'cpu-1', spec: {} }] })).toEqual([]);
  });

  it('reports nothing for a node the save pruned outright', () => {
    const { svc } = makeService(withNodes());

    expect(svc.setFleetConfig({ nodes: [], prune: ['cpu-1', 'cpu-3'] })).toEqual([]);
  });

  it('turns the vm plane off once every node is tombstoned', () => {
    const { svc } = makeService(withNodes());
    expect(svc.planes()).toEqual({ vm: true, baremetal: false });

    svc.setFleetConfig({ nodes: [] });

    expect(svc.planes()).toEqual({ vm: false, baremetal: false });
  });
});
