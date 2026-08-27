import {
  APPLY_ACTION,
  APPLY_CLASS_RANK,
  applyClassFor,
  type ApplyAction,
  type ApplyClass,
  type FleetPending,
  type StackPending,
} from '@/contract';
import { pendingChangeCount } from '@/lib/pending';

/** Which form owns a row, so a dirty form blocks only its own domain. Editing a stack knob does not
 *  make a fleet apply unsafe. */
export type ApplyDomain = 'stack' | 'fleet' | 'zones';

export interface ApplyRow {
  id: string;
  domain: ApplyDomain;
  /** What is waiting — the paths, or the fleet's own drift counts. */
  detail: string;
  /** What the apply costs, in the operator's words. */
  cost: string;
  /** Null means no action exists. The row names the work and offers no button. */
  action: ApplyAction | null;
  destructive: boolean;
  blockedBy: string | null;
  /** Ordered work the action performs, for the disclosure. Empty for a single-step apply. */
  steps: { id: string; label: string; why: string }[];
}

/** What applying each class actually costs. The record is total over the enum, so a class added to
 *  the contract is a type error here rather than a blank line. */
const COST: Record<ApplyClass, string> = {
  inert: 'nothing reads this — applying changes nothing',
  auto: 'already applied on save',
  'reload-hub': 'needs a hub reload',
  'reload-spoke': 'needs a spoke reload',
  redeploy: 'needs a redeploy',
  'fleet-op': 'needs a fleet apply',
  'rebind-recreate': 'needs a full recreation — a reload cannot pick it up',
  reslot: 'needs a full recreation on the new port band',
  'zone-apply': 'needs the zone seed, which also restarts the bridges',
  'datastore-reset': 'needs a datastore reset, which wipes the hub DB and Redis',
};

/** Every distinct class, strongest first. Rank cannot pick one for the operator: reload-hub and
 *  reload-spoke tie, so naming only the strongest hides a reload that still has to run. */
export const applyCosts = (classes: readonly ApplyClass[]): string[] =>
  [...new Set(classes)].sort((a, b) => APPLY_CLASS_RANK[b] - APPLY_CLASS_RANK[a]).map((cls) => COST[cls]);

const DOMAIN: Record<ApplyClass, ApplyDomain> = {
  inert: 'stack',
  auto: 'stack',
  'reload-hub': 'stack',
  'reload-spoke': 'stack',
  redeploy: 'stack',
  'fleet-op': 'fleet',
  'rebind-recreate': 'stack',
  reslot: 'stack',
  'zone-apply': 'zones',
  'datastore-reset': 'stack',
};

const DESTRUCTIVE: ReadonlySet<ApplyClass> = new Set<ApplyClass>(['datastore-reset']);

const blockOf = (domain: ApplyDomain, dirtyDomain: ApplyDomain | null): string | null =>
  dirtyDomain === domain ? 'save first' : null;

/** Rows the panel renders, strongest first. A read that failed and a stack that is clean both return
 *  none, so the caller must report the failure itself rather than let an empty list stand for it. */
export function applyRows(input: {
  pending: StackPending | null;
  fleet?: FleetPending | null;
  dirtyDomain?: ApplyDomain | null;
}): ApplyRow[] {
  const { pending, fleet } = input;
  const dirtyDomain = input.dirtyDomain ?? null;
  const rows: ApplyRow[] = [];
  if (pending !== null && pending.seeded) {
    rows.push(...stackRows(pending, dirtyDomain));
  }
  if (fleet != null && !fleet.inSync) rows.push(fleetRow(fleet, dirtyDomain));
  return rows;
}

function stackRows(pending: StackPending, dirtyDomain: ApplyDomain | null): ApplyRow[] {
  const byClass = new Map<ApplyClass, string[]>();
  const unclassified: string[] = [];
  for (const path of pending.savedNotApplied.paths) {
    const cls = applyClassFor(path);
    if (cls === null) {
      unclassified.push(path);
      continue;
    }
    byClass.set(cls, [...(byClass.get(cls) ?? []), path]);
  }

  const rows: ApplyRow[] = [...byClass.entries()]
    .sort(([a], [b]) => APPLY_CLASS_RANK[b] - APPLY_CLASS_RANK[a])
    .map(([cls, paths]) => ({
      id: cls,
      domain: DOMAIN[cls],
      detail: paths.join(' · '),
      cost: COST[cls],
      action: APPLY_ACTION[cls],
      destructive: DESTRUCTIVE.has(cls),
      blockedBy: blockOf(DOMAIN[cls], dirtyDomain),
      steps: cls === 'zone-apply' ? pending.zoneSteps : [],
    }));

  if (unclassified.length > 0) {
    rows.push({
      id: 'unclassified',
      domain: 'stack',
      detail: unclassified.join(' · '),
      cost: 'no rule owns this path, so its cost is unknown — a redeploy is the safe move',
      action: null,
      destructive: false,
      blockedBy: null,
      steps: [],
    });
  }

  // the latch is armed by a write, and a plain reload cannot pick it up — so it is its own row unless a
  // recreate row already carries the same demand.
  if (pending.rebindArmed && !byClass.has('rebind-recreate')) {
    rows.push({
      id: 'rebind',
      domain: 'stack',
      detail: 'a datastore or LAN binding moved',
      cost: COST['rebind-recreate'],
      action: APPLY_ACTION['rebind-recreate'],
      destructive: false,
      blockedBy: blockOf('stack', dirtyDomain),
      steps: [],
    });
  }

  if (pending.unknownSince !== null) {
    rows.push({
      id: 'unknown',
      domain: 'stack',
      detail: `the overlay changed at ${pending.unknownSince} and this control center did not write it`,
      cost: 'what is outstanding cannot be told, so a redeploy is the safe move',
      action: { kind: 'redeploy' },
      destructive: false,
      blockedBy: blockOf('stack', dirtyDomain),
      steps: [],
    });
  }

  if (pending.restart.status === 'failed' || pending.restart.status === 'stale') {
    rows.push({
      id: 'restart',
      domain: 'stack',
      detail: `the last stack recreation is ${pending.restart.status}`,
      cost:
        pending.restart.status === 'failed'
          ? 'read the log before running anything else'
          : 'it passed the stale bound, so read the log rather than wait',
      action: null,
      destructive: false,
      blockedBy: null,
      steps: [],
    });
  }
  return rows;
}

function fleetRow(fleet: FleetPending, dirtyDomain: ApplyDomain | null): ApplyRow {
  const modeChange = fleet.severity === 'mode-change';
  const n = pendingChangeCount(fleet);
  const parts = [
    fleet.summary.added && `${fleet.summary.added} added`,
    fleet.summary.removed && `${fleet.summary.removed} removed`,
    fleet.summary.changed && `${fleet.summary.changed} changed`,
    fleet.network.changed && 'network',
  ].filter(Boolean);
  return {
    id: modeChange ? 'fleet-mode' : 'fleet',
    domain: 'fleet',
    detail: modeChange
      ? 'the desired fleet mode differs from the applied one'
      : parts.join(', ') || fleet.note || `${n} pending`,
    cost:
      fleet.severity === 'needs-full-rebuild'
        ? 'needs a full rebuild of the changed nodes'
        : modeChange
          ? 'needs the fleet-mode apply, which needs sudo'
          : COST['fleet-op'],
    action: { kind: 'stack-op', opId: modeChange ? 'fleet-mode-apply' : 'fleet-apply' },
    destructive: fleet.severity === 'needs-full-rebuild' || modeChange,
    blockedBy: blockOf('fleet', dirtyDomain),
    steps: [],
  };
}
