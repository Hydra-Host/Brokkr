import { type ApplyClass } from './schemas/stack';

export type ApplyAction =
  | { kind: 'reload'; group: 'hub' | 'spoke' }
  | { kind: 'redeploy' }
  | { kind: 'stack-op'; opId: string };

/** The one action that clears each class of outstanding work. `null` means no action exists because
 *  none is needed: nothing reads an inert knob, and an auto knob applied itself on save. */
export const APPLY_ACTION: Record<ApplyClass, ApplyAction | null> = {
  inert: null,
  auto: null,
  'reload-hub': { kind: 'reload', group: 'hub' },
  'reload-spoke': { kind: 'reload', group: 'spoke' },
  redeploy: { kind: 'redeploy' },
  'fleet-op': { kind: 'stack-op', opId: 'fleet-apply' },
  'rebind-recreate': { kind: 'redeploy' },
  reslot: { kind: 'redeploy' },
  'zone-apply': { kind: 'stack-op', opId: 'zone-seed' },
  'datastore-reset': { kind: 'stack-op', opId: 'reinit' },
};

const RELOADS = ['inert', 'auto', 'reload-hub', 'reload-spoke'] as const;
const RECREATES = [...RELOADS, 'redeploy', 'rebind-recreate'] as const;

/** Which classes an apply actually reaches. Rank cannot answer this: `reload-hub` and `reload-spoke`
 *  tie at 3, so a ceiling comparison lets a hub reload clear a spoke path it never restarted. */
export const APPLY_SATISFIES: Record<ApplyClass, readonly ApplyClass[]> = {
  inert: ['inert'],
  auto: ['inert', 'auto'],
  'reload-hub': ['inert', 'auto', 'reload-hub'],
  'reload-spoke': ['inert', 'auto', 'reload-spoke'],
  redeploy: [...RELOADS, 'redeploy'],
  // a fleet apply drives libvirt, restarting no hub or spoke process, so it reaches only its own class
  'fleet-op': ['inert', 'auto', 'fleet-op'],
  'rebind-recreate': RECREATES,
  reslot: [...RECREATES, 'reslot'],
  // the op seeds the hub row, the acl user and the token, then restarts the bridges — so it reaches
  // the spoke reload, but not the hub, which it never touches
  'zone-apply': ['inert', 'auto', 'reload-spoke', 'zone-apply'],
  // reinit comes back up through the whole init dag, so it is the only apply that reaches everything
  'datastore-reset': [...RECREATES, 'reslot', 'fleet-op', 'zone-apply', 'datastore-reset'],
};

export const applySatisfies = (performed: ApplyClass, outstanding: ApplyClass): boolean =>
  APPLY_SATISFIES[performed].includes(outstanding);
