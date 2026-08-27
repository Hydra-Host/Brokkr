import { describe, expect, it, vi } from 'vitest';

import { ZonesService, zoneUuid } from '../zones.service';

const overlayStub = (over: Record<string, unknown> = {}) => ({
  zonesMeta: () => [{ name: 'sim-zone', index: 0, bridges: 1 }],
  labBridges: () => [{ proc: 'spoke', zone: 'sim-zone', replica: 0, port: 8000, grpc: 9082 }],
  fleetNodesByZone: () => ({ 'sim-zone': ['cpu-1'] }),
  zoneFiles: () => ({ 'sim-zone': ['devenv/modules/fleet-topology.nix'] }),
  zoneCapacity: () => 25,
  isSeeded: () => true,
  setZonesConfig: vi.fn(),
  ...over,
});

const registryStub = (zones: { id: string; name: string | null; deletedAt: boolean }[], readError: string | null = null) => ({
  readZones: () => Promise.resolve({ zones, readError }),
});

const make = (overlay = overlayStub(), registry = registryStub([{ id: 'z0', name: 'sim-zone', deletedAt: false }])) =>
  new ZonesService(overlay as never, registry as never);

describe('zoneUuid', () => {
  it('keeps the legacy uuid for index 0, which is why moving an index moves the hub row', () => {
    expect(zoneUuid(0)).toBe('00000000-0000-0000-0000-111111111111');
    expect(zoneUuid(1)).not.toBe(zoneUuid(0));
  });

  it('agrees with zones.nix and zones.py at an index above 0, which the hub Zone row is written from', () => {
    expect(zoneUuid(1)).toBe('00000000-0000-0000-0000-111111111112');
    expect(zoneUuid(2)).toBe('00000000-0000-0000-0000-111111111113');
    expect(zoneUuid(88)).toBe('00000000-0000-0000-0000-111111111199');
  });

  it('never mints a tail inside the sim device id namespace', () => {
    expect([0, 1, 2, 88].map(zoneUuid)).not.toContain('00000000-0000-0000-0000-000000000001');
  });

  it('refuses an index the other two implementations refuse', () => {
    expect(() => zoneUuid(-1)).toThrow(RangeError);
    expect(() => zoneUuid(89)).toThrow(RangeError);
    expect(() => zoneUuid(1.5)).toThrow(RangeError);
  });

  it('derives a distinct uuid per index', () => {
    expect(new Set([1, 2, 3].map(zoneUuid)).size).toBe(3);
  });
});

describe('ZonesService.getConfig', () => {
  it('reports what the overlay sets beside what nix derives from it', async () => {
    const cfg = await make().getConfig();

    expect(cfg.zones[0]).toMatchObject({ name: 'sim-zone', index: 0, bridges: 1 });
    expect(cfg.zones[0].derived).toMatchObject({
      uuid: zoneUuid(0),
      bridges: [{ proc: 'spoke', port: 8000, grpc: 9082 }],
      nodeCount: 1,
    });
  });

  it('marks a zone another file declares, since removing it needs the tombstone', async () => {
    expect((await make().getConfig()).zones[0].baseDeclared).toBe(true);
  });

  it('marks a zone only the overlay declares as safe to drop', async () => {
    const overlay = overlayStub({ zoneFiles: () => ({ 'sim-zone': ['stack.local.nix'] }) });
    expect((await make(overlay).getConfig()).zones[0].baseDeclared).toBe(false);
  });

  it('fails closed when nix reported no file list at all', async () => {
    const overlay = overlayStub({ zoneFiles: () => ({}) });
    expect((await make(overlay).getConfig()).zones[0].baseDeclared).toBe(true);
  });

  it('carries the ordinal budget with what the zones use of it', async () => {
    expect((await make().getConfig()).capacity).toEqual({ used: 1, total: 25 });
  });

  it('reports nothing to reconcile when both sides agree', async () => {
    expect((await make().getConfig()).reconcile).toEqual([]);
  });

  it('labels the seeded maintenance zone a fixture rather than drift', async () => {
    const registry = registryStub([
      { id: 'z0', name: 'sim-zone', deletedAt: false },
      { id: 'zf', name: 'sim-zone-maintenance', deletedAt: false },
    ]);
    const cfg = await make(overlayStub(), registry).getConfig();

    expect(cfg.reconcile).toEqual([
      { name: 'sim-zone-maintenance', zoneId: 'zf', side: 'hub-only', fixture: true },
    ]);
  });

  it('reports a genuine hub-only zone as not a fixture', async () => {
    const registry = registryStub([
      { id: 'z0', name: 'sim-zone', deletedAt: false },
      { id: 'zx', name: 'stray', deletedAt: false },
    ]);
    const cfg = await make(overlayStub(), registry).getConfig();

    expect(cfg.reconcile).toEqual([{ name: 'stray', zoneId: 'zx', side: 'hub-only', fixture: false }]);
  });

  it('reports a declared zone the hub has not seeded', async () => {
    const registry = registryStub([]);
    const cfg = await make(overlayStub(), registry).getConfig();

    expect(cfg.reconcile).toEqual([{ name: 'sim-zone', zoneId: null, side: 'fleet-only', fixture: false }]);
  });

  it('ignores a deleted hub row, which has no bridges to reconcile against', async () => {
    const registry = registryStub([
      { id: 'z0', name: 'sim-zone', deletedAt: false },
      { id: 'zd', name: 'gone', deletedAt: true },
    ]);
    expect((await make(overlayStub(), registry).getConfig()).reconcile).toEqual([]);
  });

  it('surfaces a hub read failure, so an empty reconcile list is not read as agreement', async () => {
    const registry = registryStub([], 'connection refused');
    expect((await make(overlayStub(), registry).getConfig()).hubReadError).toBe('connection refused');
  });
});

describe('ZonesService.putConfig', () => {
  it('persists an accepted set and asks for the bridge restart', async () => {
    const overlay = overlayStub();
    const res = await make(overlay).putConfig({ zones: [{ name: 'sim-zone', index: 0, bridges: 1 }] });

    expect(res.ok).toBe(true);
    expect(res.plan.steps.map((s) => s.id)).toEqual(['restart the bridges']);
    expect(overlay.setZonesConfig).toHaveBeenCalledOnce();
  });

  it('refuses a set the rules reject and writes nothing', async () => {
    const overlay = overlayStub();
    await expect(
      make(overlay).putConfig({
        zones: [
          { name: 'a', index: 1, bridges: 1 },
          { name: 'b', index: 1, bridges: 1 },
        ],
      }),
    ).rejects.toThrow(/duplicate zone index/);
    expect(overlay.setZonesConfig).not.toHaveBeenCalled();
  });

  it('hands the ordered steps to the overlay, so the plan outlives the response', async () => {
    const overlay = overlayStub();

    const res = await make(overlay).putConfig({ zones: [{ name: 'sim-zone', index: 0, bridges: 1 }] });

    expect(overlay.setZonesConfig.mock.calls[0][0].steps).toEqual(res.plan.steps);
  });

  it('orders a rename so the acl seed precedes the bridge restart', async () => {
    const res = await make().putConfig({
      zones: [{ name: 'edge', index: 0, bridges: 1 }],
      rename: { from: 'sim-zone', to: 'edge' },
    });

    expect(res.plan.steps.map((s) => s.id)).toEqual([
      'sim:seed',
      'redis-acl:seed',
      'zone-crypto:mint-tokens',
      'restart the bridges',
    ]);
  });

  it('prescribes seed, acl and mint before the restart when an index change mints a new uuid', async () => {
    const res = await make().putConfig({ zones: [{ name: 'sim-zone', index: 1, bridges: 1 }] });

    expect(res.plan.steps.map((s) => s.id)).toEqual([
      'sim:seed',
      'redis-acl:seed',
      'zone-crypto:mint-tokens',
      'restart the bridges',
    ]);
    expect(res.plan.steps[0].why).toMatch(/no Zone row yet/);
  });

  it('prescribes the same order when a zone is added, which also mints a uuid', async () => {
    const res = await make().putConfig({
      zones: [
        { name: 'sim-zone', index: 0, bridges: 1 },
        { name: 'edge', index: 1, bridges: 1 },
      ],
      nodeZones: { 'cpu-1': 'sim-zone' },
    });

    expect(res.plan.steps.map((s) => s.id)).toEqual([
      'sim:seed',
      'redis-acl:seed',
      'zone-crypto:mint-tokens',
      'restart the bridges',
    ]);
  });

  it('stays a bare restart when only the bridge count moves, since no uuid changes', async () => {
    const res = await make().putConfig({ zones: [{ name: 'sim-zone', index: 0, bridges: 2 }] });

    expect(res.plan.steps.map((s) => s.id)).toEqual(['restart the bridges']);
  });

  it('says on the restart step what running it first would cost', async () => {
    const res = await make().putConfig({
      zones: [{ name: 'edge', index: 0, bridges: 1 }],
      rename: { from: 'sim-zone', to: 'edge' },
    });

    expect(res.plan.steps.find((s) => s.id === 'restart the bridges')?.why).toMatch(/WRONGPASS/);
  });

  it('keeps every node where it was when the write omits node zones', async () => {
    const overlay = overlayStub();
    await make(overlay).putConfig({ zones: [{ name: 'sim-zone', index: 0, bridges: 1 }] });

    expect(overlay.setZonesConfig.mock.calls[0][0].nodeZones).toEqual({ 'cpu-1': 'sim-zone' });
  });

  it('flags a full rebuild when a node changes zone, which is an identity field', async () => {
    const res = await make().putConfig({
      zones: [
        { name: 'sim-zone', index: 0, bridges: 1 },
        { name: 'edge', index: 1, bridges: 1 },
      ],
      nodeZones: { 'cpu-1': 'edge' },
    });

    expect(res.plan.fullRebuild).toBe(true);
  });

  it('flags no rebuild when every node stays where it was', async () => {
    const res = await make().putConfig({
      zones: [{ name: 'sim-zone', index: 0, bridges: 1 }],
      nodeZones: { 'cpu-1': 'sim-zone' },
    });

    expect(res.plan.fullRebuild).toBe(false);
  });
});

describe('ZonesService.putConfig — a rename carries its nodes', () => {
  it('moves the nodes with the zone rather than refusing the save', async () => {
    const overlay = overlayStub();
    await make(overlay).putConfig({
      zones: [{ name: 'edge', index: 0, bridges: 1 }],
      rename: { from: 'sim-zone', to: 'edge' },
    });

    expect(overlay.setZonesConfig.mock.calls[0][0].nodeZones).toEqual({ 'cpu-1': 'edge' });
  });

  it('calls for no rebuild, because the zone keeps its index and every derived identity with it', async () => {
    const res = await make().putConfig({
      zones: [{ name: 'edge', index: 0, bridges: 1 }],
      rename: { from: 'sim-zone', to: 'edge' },
    });

    expect(res.plan.fullRebuild).toBe(false);
  });
});

describe('ZonesService.putConfig — an unreadable hub', () => {
  it('refuses a rename it cannot check for a name clash, rather than passing vacuously', async () => {
    const overlay = overlayStub();
    const registry = registryStub([], 'connection refused');
    await expect(
      make(overlay, registry).putConfig({
        zones: [{ name: 'edge', index: 0, bridges: 1 }],
        rename: { from: 'sim-zone', to: 'edge' },
      }),
    ).rejects.toThrow(/could not be read/);
    expect(overlay.setZonesConfig).not.toHaveBeenCalled();
  });

  it('still allows a save that renames nothing, which needs no hub read', async () => {
    const overlay = overlayStub();
    const registry = registryStub([], 'connection refused');
    await make(overlay, registry).putConfig({ zones: [{ name: 'sim-zone', index: 0, bridges: 1 }] });
    expect(overlay.setZonesConfig).toHaveBeenCalledOnce();
  });
});
