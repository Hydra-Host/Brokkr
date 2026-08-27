import type { TopologyModel } from './fleet-topology';

export const LANE_WIDTH = 190;
export const LANE_GAP = 18;
export const ROW_ROOT = 26;
export const ROW_ZONE = 84;
export const ROW_BRIDGE = 146;
export const NODE_ROW_TOP = 206;
export const NODE_ROW_HEIGHT = 34;
export const PAD_X = 12;
export const PAD_BOTTOM = 16;

export interface Placed {
  /** Stable across renders, so React keys and hover targets do not shuffle. */
  key: string;
  x: number;
  y: number;
  width: number;
}

export interface PlacedZone extends Placed {
  zoneName: string;
  bridges: Placed[];
  nodes: Placed[];
}

export interface Edge {
  from: { x: number; y: number };
  to: { x: number; y: number };
  zoneName: string;
}

export interface Layout {
  width: number;
  height: number;
  root: Placed;
  zones: PlacedZone[];
  edges: Edge[];
}

const laneX = (i: number): number => PAD_X + i * (LANE_WIDTH + LANE_GAP);
const centre = (x: number): number => x + LANE_WIDTH / 2;

/** Deterministic rather than force-directed: a stack runs a handful of zones and at most four nodes
 *  each, so positions are arithmetic and the layout can be asserted instead of eyeballed. */
export function layoutTopology(model: TopologyModel): Layout {
  const lanes = model.zones.length;
  const width = lanes === 0 ? LANE_WIDTH + PAD_X * 2 : PAD_X * 2 + lanes * LANE_WIDTH + (lanes - 1) * LANE_GAP;
  const deepest = model.zones.reduce((most, zone) => Math.max(most, zone.nodes.length), 0);
  const height = NODE_ROW_TOP + Math.max(deepest, 1) * NODE_ROW_HEIGHT + PAD_BOTTOM;

  const root: Placed = { key: 'fleet', x: PAD_X, y: ROW_ROOT, width: width - PAD_X * 2 };

  const zones: PlacedZone[] = model.zones.map((zone, i) => {
    const x = laneX(i);
    return {
      key: `zone-${zone.name}`,
      zoneName: zone.name,
      x,
      y: ROW_ZONE,
      width: LANE_WIDTH,
      bridges: zone.bridges.map((bridge, b) => ({
        key: `bridge-${zone.name}-${bridge.proc}`,
        x,
        y: ROW_BRIDGE + b * 18,
        width: LANE_WIDTH,
      })),
      nodes: zone.nodes.map((node, n) => ({
        key: `node-${node.name}`,
        x,
        y: NODE_ROW_TOP + n * NODE_ROW_HEIGHT,
        width: LANE_WIDTH,
      })),
    };
  });

  const edges: Edge[] = zones.flatMap((zone) => [
    {
      from: { x: centre(root.x + (root.width - LANE_WIDTH) / 2), y: ROW_ROOT + 14 },
      to: { x: centre(zone.x), y: ROW_ZONE },
      zoneName: zone.zoneName,
    },
    ...zone.nodes.map((node) => ({
      from: { x: centre(zone.x), y: ROW_ZONE + 20 },
      to: { x: centre(node.x), y: node.y },
      zoneName: zone.zoneName,
    })),
  ]);

  return { width, height, root, zones, edges };
}
