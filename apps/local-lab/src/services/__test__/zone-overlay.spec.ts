import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { OverlayStoreService } from '../overlay-store';
import type { ProcessComposeClient } from '../process-compose.client';
import { RenderedConfigService } from '../rendered-config.service';

type Mirror = Record<string, unknown>;
type Internals = { mirror: Mirror | null; overlayPath(): string };

const BASE_ZONE = { name: 'sim-zone', index: 0, bridges: 1 };

function makeService(over: Mirror = {}): { svc: OverlayStoreService; overlay: () => string } {
  const pc = {} as unknown as ProcessComposeClient;
  const root = mkdtempSync(join(tmpdir(), 'lab-zones-'));
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
    catalog: [],
    provenance: [],
    values: [],
    envPins: {},
    portKeys: { editable: [], readOnly: [] },
    ports: {},
    portDefaults: {},
    observabilityPorts: {},
    bridges: [],
    fleet: { network: {}, defaults: {}, nodes: { 'cpu-1': { zone: 'sim-zone', index: 0 } } },
    fleetOwned: true,
    mode: 'vm',
    baremetal: null,
    baremetalOwned: false,
    zonesMeta: [BASE_ZONE],
    fleetNodeFiles: {},
    zoneCapacity: 25,
    zoneFiles: { 'sim-zone': ['devenv/modules/fleet-topology.nix'] },
    zoneTombstones: [],
    options: {},
    ...over,
  };
  return { svc, overlay: () => readFileSync(t.overlayPath(), 'utf8') };
}

afterEach(() => vi.unstubAllEnvs());

describe('OverlayStoreService.setZonesConfig — byte parity', () => {
  it('emits no zone line for the default single zone, so the render stays byte-identical', () => {
    const { svc, overlay } = makeService();

    svc.setZonesConfig({ zones: [BASE_ZONE], nodeZones: { 'cpu-1': 'sim-zone' } });

    expect(overlay()).not.toMatch(/fleet\.zones\."sim-zone"\.index/);
    expect(overlay()).not.toMatch(/fleet\.zones\."sim-zone"\.bridges/);
  });

  it('emits both leaves once a second zone exists', () => {
    const { svc, overlay } = makeService();

    svc.setZonesConfig({
      zones: [BASE_ZONE, { name: 'edge', index: 1, bridges: 2 }],
      nodeZones: { 'cpu-1': 'sim-zone' },
    });

    const out = overlay();
    expect(out).toMatch(/fleet\.zones\."sim-zone"\.index = 0;/);
    expect(out).toMatch(/fleet\.zones\."edge"\.index = 1;/);
    expect(out).toMatch(/fleet\.zones\."edge"\.bridges = 2;/);
  });

  it('emits both leaves for a lone zone that is not the canonical one', () => {
    const { svc, overlay } = makeService();

    svc.setZonesConfig({ zones: [{ name: 'edge', index: 0, bridges: 1 }], nodeZones: {} });

    expect(overlay()).toMatch(/fleet\.zones\."edge"\.index = 0;/);
  });

  it('emits both leaves for one canonical zone that grew a bridge', () => {
    const { svc, overlay } = makeService();

    svc.setZonesConfig({ zones: [{ ...BASE_ZONE, bridges: 2 }], nodeZones: {} });

    expect(overlay()).toMatch(/fleet\.zones\."sim-zone"\.bridges = 2;/);
  });
});

describe('OverlayStoreService.setZonesConfig — removal', () => {
  it('tombstones a zone another file declares, because dropping its key brings it back', () => {
    const { svc, overlay } = makeService({
      zonesMeta: [BASE_ZONE, { name: 'edge', index: 1, bridges: 1 }],
      zoneFiles: {
        'sim-zone': ['devenv/modules/fleet-topology.nix'],
        edge: ['devenv/modules/fleet-topology.nix', 'stack.local.nix'],
      },
    });

    svc.setZonesConfig({ zones: [BASE_ZONE], nodeZones: {} });

    expect(overlay()).toMatch(/fleet\.zones\."edge"\.enable = false;/);
  });

  it('drops the key outright for a zone only the overlay declared', () => {
    const { svc, overlay } = makeService({
      zonesMeta: [BASE_ZONE, { name: 'edge', index: 1, bridges: 1 }],
      zoneFiles: { 'sim-zone': ['devenv/modules/fleet-topology.nix'], edge: ['stack.local.nix'] },
    });

    svc.setZonesConfig({ zones: [BASE_ZONE], nodeZones: {} });

    expect(overlay()).not.toMatch(/edge/);
  });

  it('re-emits an existing tombstone, or the next eval brings that zone back', () => {
    const { svc, overlay } = makeService({ zoneTombstones: ['old'] });

    svc.setZonesConfig({ zones: [BASE_ZONE], nodeZones: {} });

    expect(overlay()).toMatch(/fleet\.zones\."old"\.enable = false;/);
  });

  it('clears a tombstone when the zone is declared again', () => {
    const { svc, overlay } = makeService({ zoneTombstones: ['edge'] });

    svc.setZonesConfig({ zones: [BASE_ZONE, { name: 'edge', index: 1, bridges: 1 }], nodeZones: {} });

    expect(overlay()).not.toMatch(/fleet\.zones\."edge"\.enable = false;/);
  });
});

describe('OverlayStoreService.setZonesConfig — node membership', () => {
  it('writes the zone a node was moved to', () => {
    const { svc, overlay } = makeService();

    svc.setZonesConfig({
      zones: [BASE_ZONE, { name: 'edge', index: 1, bridges: 1 }],
      nodeZones: { 'cpu-1': 'edge' },
    });

    expect(overlay()).toMatch(/fleet\.zones\."edge"\.nodes\."cpu-1"/);
  });

  it('leaves a node the write does not mention where it was', () => {
    const { svc, overlay } = makeService();

    svc.setZonesConfig({ zones: [BASE_ZONE], nodeZones: {} });

    expect(overlay()).toMatch(/fleet\.zones\."sim-zone"\.nodes\."cpu-1"/);
  });
});
