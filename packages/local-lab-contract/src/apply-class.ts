import { APPLY_CLASS_RANK, type ApplyClass } from './schemas/stack';

/** Longest prefix wins, so `stack.slot` beats the bare `stack` namespace and `fleet.zones` beats
 *  `fleet.`. A knob no save can reach carries no cost and stays null. */
const RULES: { prefix: string; applyClass: ApplyClass }[] = [
  { prefix: 'ports.', applyClass: 'rebind-recreate' },
  { prefix: 'lan.expose', applyClass: 'rebind-recreate' },
  { prefix: 'stackDefaults.spoke.', applyClass: 'reload-spoke' },
  { prefix: 'stackDefaults.spoke.AGENT_SSH_FORCE_REDEPLOY', applyClass: 'inert' },
  { prefix: 'stackDefaults.spoke.ANALYTICS_ENABLED', applyClass: 'inert' },
  { prefix: 'stackDefaults.hub.', applyClass: 'reload-hub' },
  { prefix: 'identity.', applyClass: 'datastore-reset' },
  { prefix: 'fleet.', applyClass: 'fleet-op' },
  { prefix: 'fleet.zones', applyClass: 'zone-apply' },
  { prefix: 'osLayerCache.', applyClass: 'rebind-recreate' },
  { prefix: 'stackCounts.', applyClass: 'inert' },
  { prefix: 'stack.slot', applyClass: 'reslot' },
  { prefix: 'telemetry.enable', applyClass: 'auto' },
  { prefix: 'spoke.watch', applyClass: 'redeploy' },
  { prefix: 'stack.fleetNodeCount', applyClass: 'fleet-op' },
  { prefix: 'redisAcl.', applyClass: 'redeploy' },
  { prefix: 'vrrpSim.', applyClass: 'redeploy' },
];

/** States what applying a change costs, never whether the path is editable — `writableFor` alone
 *  answers that. Null is right only for a knob no save can reach. */
export function applyClassFor(path: string): ApplyClass | null {
  let best: { prefix: string; applyClass: ApplyClass } | null = null;
  for (const rule of RULES) {
    if (!path.startsWith(rule.prefix)) continue;
    if (!best || rule.prefix.length > best.prefix.length) best = rule;
  }
  return best?.applyClass ?? null;
}

/** The strongest class in a change set, which is what applying the whole set actually costs. */
export const strongestApplyClass = (classes: readonly ApplyClass[]): ApplyClass | null =>
  classes.length === 0 ? null : classes.reduce((a, b) => (APPLY_CLASS_RANK[b] > APPLY_CLASS_RANK[a] ? b : a));

export const APPLY_CLASS_PREFIXES: readonly string[] = RULES.map((r) => r.prefix);
