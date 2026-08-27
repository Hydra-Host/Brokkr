import { useState, type KeyboardEvent } from 'react';

import type { Health, TopologyModel, TopologyNode } from './fleet-topology';
import { LANE_WIDTH, layoutTopology } from './topology-layout';

const HEALTH_FILL: Record<Health, string> = {
  ok: 'var(--color-status-online)',
  degraded: 'var(--color-status-warning)',
  unknown: 'var(--color-text-label)',
};

const POWER_FILL: Record<string, string> = {
  on: 'var(--color-status-online)',
  off: 'var(--color-text-label)',
  unknown: 'var(--color-status-warning)',
};

/** A `g` is not natively focusable, so a role of button without these is a promise the markup does
 *  not keep. Absent a handler the element leaves the tab order rather than focusing to do nothing. */
const activates = (fn: (() => void) | undefined) => ({
  role: 'button',
  tabIndex: fn ? 0 : -1,
  onClick: fn,
  onKeyDown: (event: KeyboardEvent) => {
    if (fn && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      fn();
    }
  },
});

/** Null power is a missing answer, not an off domain, so it reads as unknown rather than off. */
const powerFill = (power: TopologyNode['power']): string => POWER_FILL[power ?? 'unknown'];
const powerTitle = (power: TopologyNode['power']): string =>
  power === null ? 'no live answer covered this node' : `power ${power}`;

export function FleetGraph({
  model,
  onSelectZone,
  onSelectNode,
}: {
  model: TopologyModel;
  onSelectZone?: (zone: string) => void;
  onSelectNode?: (node: string) => void;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const layout = layoutTopology(model);
  const dim = (zoneName: string): number => (hover === null || hover === zoneName ? 1 : 0.35);

  if (model.zones.length === 0) {
    return <div className="text-text-dim text-[11px]">no zones declared — add one below to draw the fleet</div>;
  }

  return (
    <div className="space-y-1">
      <div className="overflow-x-auto">
        <svg
          role="img"
          aria-label="Fleet topology: zones, their bridges and their nodes"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="max-w-full"
        >
          {layout.edges.map((edge, i) => (
            <line
              key={`${edge.zoneName}-${i}`}
              x1={edge.from.x}
              y1={edge.from.y}
              x2={edge.to.x}
              y2={edge.to.y}
              stroke="var(--color-border-dim)"
              strokeWidth={1}
              opacity={dim(edge.zoneName)}
            />
          ))}

          <rect
            x={layout.root.x}
            y={layout.root.y}
            width={layout.root.width}
            height={20}
            rx={4}
            fill="var(--color-text-dim)"
            fillOpacity={0.06}
            stroke="var(--color-border-dim)"
          />
          <text x={layout.root.x + 8} y={layout.root.y + 14} className="fill-text-muted text-[10px]">
            fleet · {model.capacity.used} of {model.capacity.total} bridge ordinals used
          </text>

          {layout.zones.map((placed) => {
            const zone = model.zones.find((z) => z.name === placed.zoneName);
            if (zone === undefined) return null;
            return (
              <g
                key={placed.key}
                opacity={dim(placed.zoneName)}
                onMouseEnter={() => setHover(placed.zoneName)}
                onMouseLeave={() => setHover(null)}
              >
                <g
                  {...activates(onSelectZone && (() => onSelectZone(placed.zoneName)))}
                  aria-label={`zone ${zone.name} — ${zone.healthReason}`}
                  className={onSelectZone ? 'cursor-pointer' : undefined}
                >
                  <rect
                    x={placed.x}
                    y={placed.y}
                    width={LANE_WIDTH}
                    height={20}
                    rx={4}
                    fill={HEALTH_FILL[zone.health]}
                    fillOpacity={0.14}
                    stroke={HEALTH_FILL[zone.health]}
                    strokeOpacity={0.5}
                  />
                  <text x={placed.x + 8} y={placed.y + 14} className="fill-text-primary font-mono text-[10px]">
                    {zone.name} · idx {zone.index}
                  </text>
                </g>

                {placed.bridges.map((bridge, b) => {
                  const live = zone.bridges[b];
                  return (
                    <g key={bridge.key}>
                      <circle
                        cx={bridge.x + 8}
                        cy={bridge.y + 6}
                        r={3}
                        fill={
                          live.online === null
                            ? 'var(--color-status-warning)'
                            : live.online
                              ? 'var(--color-status-online)'
                              : 'var(--color-status-offline)'
                        }
                        aria-label={`${live.proc}: ${
                          live.online === null ? 'presence unread' : live.online ? 'online' : 'offline'
                        }`}
                      />
                      <text x={bridge.x + 16} y={bridge.y + 9} className="fill-text-dim font-mono text-[9px]">
                        {live.leader ? '★ ' : ''}
                        {live.proc} :{live.port}/:{live.grpc}
                      </text>
                    </g>
                  );
                })}

                {placed.nodes.map((tile, n) => {
                  const node = zone.nodes[n];
                  return (
                    <g
                      key={tile.key}
                      {...activates(onSelectNode && (() => onSelectNode(node.name)))}
                      aria-label={`node ${node.name} in zone ${zone.name}`}
                      className={onSelectNode ? 'cursor-pointer' : undefined}
                    >
                      <rect
                        x={tile.x}
                        y={tile.y}
                        width={LANE_WIDTH}
                        height={26}
                        rx={4}
                        fill="var(--color-text-dim)"
                        fillOpacity={0.04}
                        stroke="var(--color-border-dim)"
                      />
                      <circle
                        cx={tile.x + 10}
                        cy={tile.y + 13}
                        r={4}
                        fill={powerFill(node.power)}
                        aria-label={`${node.name}: ${powerTitle(node.power)}`}
                      />
                      <text x={tile.x + 20} y={tile.y + 11} className="fill-text-primary font-mono text-[10px]">
                        {node.name}
                      </text>
                      <text x={tile.x + 20} y={tile.y + 21} className="fill-text-dim font-mono text-[9px]">
                        {node.cpus}c · {Math.round(node.memoryMb / 1024)}G · {node.diskGb}G
                        {node.arch ? ` · ${node.arch}` : ''}
                      </text>
                    </g>
                  );
                })}

                {placed.nodes.length === 0 && (
                  <text x={placed.x + 8} y={placed.y + 122} className="fill-status-warning font-mono text-[9px]">
                    no nodes — add one below
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <OrphanLanes model={model} onSelectNode={onSelectNode} />
    </div>
  );
}

/** The states the flat grid hid. Each is named rather than folded into a count. */
function OrphanLanes({ model, onSelectNode }: { model: TopologyModel; onSelectNode?: (node: string) => void }) {
  const rows: { label: string; items: string[]; why: string }[] = [
    {
      label: 'unassigned',
      items: model.orphanNodes.map((node) => `${node.name} → ${node.zone}`),
      why: 'names a zone nothing declares — a rename leaves this behind',
    },
    { label: 'not in config', items: model.adoptable, why: 'running, and a rebuild would adopt it' },
    { label: 'hub only', items: model.hubOnly, why: 'a hub zone row the fleet does not declare' },
  ].filter((row) => row.items.length > 0);

  if (rows.length === 0 && model.readErrors.length === 0) return null;

  return (
    <div className="space-y-1">
      {rows.map((row) => (
        <div key={row.label} className="flex flex-wrap items-baseline gap-2 text-[10px]">
          <span className="text-status-warning w-24 shrink-0 tracking-wide uppercase">{row.label}</span>
          {row.items.map((item) => (
            <button
              key={item}
              onClick={() => onSelectNode?.(item.split(' ')[0])}
              className="border-status-warning/40 text-text-muted hover:bg-hover-bg rounded border px-1.5 py-0.5 font-mono"
            >
              {item}
            </button>
          ))}
          <span className="text-text-label">{row.why}</span>
        </div>
      ))}
      {model.readErrors.map((error) => (
        <div key={error} className="text-status-warning text-[10px]">
          this graph is incomplete — {error}
        </div>
      ))}
    </div>
  );
}
