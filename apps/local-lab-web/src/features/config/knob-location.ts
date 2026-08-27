export type ConfigArea = 'stack' | 'fleet' | 'zones' | 'advanced';

export interface KnobLocation {
  area: ConfigArea;
  route: string;
  /** Rail entry, not the catalog's `group` — grouping by `group` alone gives 19 sections on one page. */
  section: string;
  anchor: string;
}

const AREA_ROUTE: Record<ConfigArea, string> = {
  stack: '/config/stack',
  fleet: '/config/fleet',
  zones: '/config/zones',
  advanced: '/config/advanced',
};

/** Areas whose route exists. A row pointing at an unbuilt one must not render as a link — a dead
 *  link reads as a broken page rather than as work still to come. */
const BUILT: Record<ConfigArea, boolean> = { stack: true, fleet: true, zones: true, advanced: true };

export const areaIsBuilt = (area: ConfigArea): boolean => BUILT[area];

/** Longest prefix wins, so `stack.slot` resolves before the bare `stack` namespace would. */
const RULES: { prefix: string; area: ConfigArea; section: string }[] = [
  { prefix: 'stackDefaults.hub.', area: 'stack', section: 'HUB' },
  { prefix: 'stackDefaults.spoke.', area: 'stack', section: 'SPOKE' },
  // no reader consumes either, so the stack editor drops them; the advanced page still lists them
  { prefix: 'stackDefaults.spoke.AGENT_SSH_FORCE_REDEPLOY', area: 'advanced', section: 'INERT' },
  { prefix: 'stackDefaults.spoke.ANALYTICS_ENABLED', area: 'advanced', section: 'INERT' },
  { prefix: 'identity.', area: 'stack', section: 'IDENTITY' },
  { prefix: 'ports.', area: 'stack', section: 'PORTS' },
  { prefix: 'osLayerCache.', area: 'stack', section: 'STACK' },
  { prefix: 'lan.', area: 'stack', section: 'STACK' },
  { prefix: 'telemetry.', area: 'stack', section: 'STACK' },
  { prefix: 'stack.slot', area: 'stack', section: 'TOPOLOGY' },
  { prefix: 'stack.fleetNodeCount', area: 'advanced', section: 'FORKS' },
  { prefix: 'stackCounts.', area: 'advanced', section: 'INERT' },
  { prefix: 'spoke.watch', area: 'advanced', section: 'FORKS' },
  { prefix: 'redisAcl.', area: 'advanced', section: 'FORKS' },
  { prefix: 'vrrpSim.', area: 'advanced', section: 'FORKS' },
  { prefix: 'zoneCrypto.', area: 'advanced', section: 'ZONE CRYPTO' },
  { prefix: 'polyrepo.', area: 'advanced', section: 'CHECKOUT' },
  { prefix: 'fleet.zones', area: 'zones', section: 'ZONES' },
  { prefix: 'fleet.mode', area: 'fleet', section: 'MODE' },
  { prefix: 'fleet.autoStart', area: 'fleet', section: 'MODE' },
  { prefix: 'fleet.network', area: 'fleet', section: 'NETWORK' },
  { prefix: 'fleet.defaults', area: 'fleet', section: 'DEFAULTS' },
  { prefix: 'fleet.', area: 'fleet', section: 'NODES' },
];

/** Every prefix the table can match, so a completeness test covers the rules rather than a hand list. */
export const KNOB_PREFIXES: readonly string[] = RULES.map((r) => r.prefix);

/** Fragment-safe and stable across renders, so a deep link and the rail agree on the target. */
export const knobAnchor = (path: string): string => `cfg-${path.replace(/[^a-zA-Z0-9_]+/g, '-')}`;

/** Null means no editor owns this path yet. That residue renders on /config/advanced rather than
 *  vanishing, so the gap stays measurable. */
export function knobLocation(path: string): KnobLocation | null {
  const rule = [...RULES].sort((a, b) => b.prefix.length - a.prefix.length).find((r) => path.startsWith(r.prefix));
  if (!rule) return null;
  return { area: rule.area, route: AREA_ROUTE[rule.area], section: rule.section, anchor: knobAnchor(path) };
}

/** Rail order per area. A section with no knobs is still rendered, so the page shape does not shift
 *  when the last override in a section is reverted. */
export const AREA_SECTIONS: Record<ConfigArea, string[]> = {
  stack: ['HUB', 'SPOKE', 'IDENTITY', 'PORTS', 'TOPOLOGY', 'STACK'],
  fleet: ['MODE', 'NETWORK', 'DEFAULTS', 'NODES'],
  zones: ['ZONES', 'RECONCILE'],
  advanced: ['FORKS', 'ZONE CRYPTO', 'CHECKOUT', 'INERT', 'NOT YET EDITABLE'],
};
