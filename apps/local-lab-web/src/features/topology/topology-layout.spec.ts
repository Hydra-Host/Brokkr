import { describe, expect, it } from 'vitest';

import type { TopologyModel, TopologyNode, TopologyZone } from './fleet-topology';
import { LANE_GAP, LANE_WIDTH, layoutTopology } from './topology-layout';

const node = (name: string, zone: string): TopologyNode => ({
  name,
  zone,
  cpus: 4,
  memoryMb: 8192,
  diskGb: 40,
  arch: null,
  power: 'on',
  deviceId: null,
});

const zone = (name: string, index: number, nodeNames: string[]): TopologyZone => ({
  name,
  index,
  uuid: `uuid-${index}`,
  ordinals: [index],
  bridges: [{ proc: `spoke-${index}`, port: 8000 + index, grpc: 9082 + index, online: true, leader: true }],
  nodes: nodeNames.map((n) => node(n, name)),
  health: 'ok',
  healthReason: 'leader spoke',
  seeded: true,
});

const model = (zones: TopologyZone[]): TopologyModel => ({
  zones,
  orphanNodes: [],
  adoptable: [],
  hubOnly: [],
  capacity: { used: zones.length, total: 47 },
  trustworthy: true,
  loading: false,
  readErrors: [],
});

describe('layoutTopology', () => {
  it('places one zone lane at the left padding', () => {
    const out = layoutTopology(model([zone('sim-zone', 0, ['cpu-1'])]));

    expect(out.zones).toHaveLength(1);
    expect(out.zones[0].x).toBe(12);
    expect(out.zones[0].zoneName).toBe('sim-zone');
  });

  it('spaces four zone lanes by exactly one gap, with no overlap', () => {
    const out = layoutTopology(
      model([zone('z0', 0, ['a']), zone('z1', 1, ['b']), zone('z2', 2, ['c']), zone('z3', 3, ['d'])]),
    );

    const xs = out.zones.map((z) => z.x);
    for (let i = 1; i < xs.length; i += 1) {
      expect(xs[i] - xs[i - 1]).toBe(LANE_WIDTH + LANE_GAP);
      expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] + LANE_WIDTH);
    }
  });

  it('stacks nodes down a lane without overlapping each other', () => {
    const out = layoutTopology(model([zone('sim-zone', 0, ['cpu-1', 'cpu-2', 'cpu-3', 'cpu-4'])]));

    const ys = out.zones[0].nodes.map((n) => n.y);
    expect(new Set(ys).size).toBe(4);
    for (let i = 1; i < ys.length; i += 1) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
  });

  it('grows the canvas to the deepest lane, not the first one', () => {
    const shallow = layoutTopology(model([zone('z0', 0, ['a'])]));
    const deep = layoutTopology(model([zone('z0', 0, ['a']), zone('z1', 1, ['b', 'c', 'd', 'e'])]));

    expect(deep.height).toBeGreaterThan(shallow.height);
    expect(deep.width).toBeGreaterThan(shallow.width);
  });

  it('gives every element a key that is stable and unique', () => {
    const out = layoutTopology(model([zone('z0', 0, ['a', 'b']), zone('z1', 1, ['c'])]));

    const keys = [
      out.root.key,
      ...out.zones.flatMap((z) => [z.key, ...z.bridges.map((b) => b.key), ...z.nodes.map((n) => n.key)]),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('draws an edge per zone and per node, each tagged with its zone', () => {
    const out = layoutTopology(model([zone('z0', 0, ['a', 'b'])]));

    expect(out.edges).toHaveLength(3);
    expect(out.edges.every((e) => e.zoneName === 'z0')).toBe(true);
  });

  it('still returns a usable canvas for a fleet with no zones', () => {
    const out = layoutTopology(model([]));

    expect(out.zones).toEqual([]);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });
});
