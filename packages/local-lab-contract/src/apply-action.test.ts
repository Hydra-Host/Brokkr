import { describe, expect, it } from 'vitest';

import { APPLY_ACTION, APPLY_SATISFIES, applySatisfies } from './apply-action';
import { APPLY_CLASS_RANK, ApplyClassSchema, type ApplyClass } from './schemas/stack';

const CLASSES = ApplyClassSchema.options;

describe('APPLY_ACTION', () => {
  it('names an action for every class the enum declares', () => {
    expect(Object.keys(APPLY_ACTION).sort()).toEqual([...CLASSES].sort());
  });

  it('offers no action only where none is needed', () => {
    const none = CLASSES.filter((c) => APPLY_ACTION[c] === null);
    expect(none).toEqual(['inert', 'auto']);
  });

  it('splits the two reloads by the process group each one restarts', () => {
    expect(APPLY_ACTION['reload-hub']).toEqual({ kind: 'reload', group: 'hub' });
    expect(APPLY_ACTION['reload-spoke']).toEqual({ kind: 'reload', group: 'spoke' });
  });

  it('routes a recreation and a slot move through the redeploy, not a reload', () => {
    expect(APPLY_ACTION['rebind-recreate']).toEqual({ kind: 'redeploy' });
    expect(APPLY_ACTION.reslot).toEqual({ kind: 'redeploy' });
  });

  it('names the op that seeds a zone change, which is not the fleet apply', () => {
    expect(APPLY_ACTION['zone-apply']).toEqual({ kind: 'stack-op', opId: 'zone-seed' });
    expect(APPLY_ACTION['fleet-op']).toEqual({ kind: 'stack-op', opId: 'fleet-apply' });
  });

  it('names the op that performs a datastore reset', () => {
    expect(APPLY_ACTION['datastore-reset']).toEqual({ kind: 'stack-op', opId: 'reinit' });
  });
});

describe('APPLY_SATISFIES', () => {
  it('covers every class the enum declares', () => {
    expect(Object.keys(APPLY_SATISFIES).sort()).toEqual([...CLASSES].sort());
  });

  it('has every class satisfy itself', () => {
    for (const c of CLASSES) expect(applySatisfies(c, c)).toBe(true);
  });

  it('keeps a hub reload off a spoke path and a spoke reload off a hub path', () => {
    expect(applySatisfies('reload-hub', 'reload-spoke')).toBe(false);
    expect(applySatisfies('reload-spoke', 'reload-hub')).toBe(false);
  });

  it('lets a redeploy clear both reloads, since it restarts the whole roster', () => {
    expect(applySatisfies('redeploy', 'reload-hub')).toBe(true);
    expect(applySatisfies('redeploy', 'reload-spoke')).toBe(true);
  });

  it('keeps a fleet apply off the service reloads it never restarts', () => {
    expect(applySatisfies('fleet-op', 'reload-hub')).toBe(false);
    expect(applySatisfies('fleet-op', 'redeploy')).toBe(false);
  });

  it('lets the zone seed clear the spoke reload it performs, but not the hub it never touches', () => {
    expect(applySatisfies('zone-apply', 'reload-spoke')).toBe(true);
    expect(applySatisfies('zone-apply', 'reload-hub')).toBe(false);
    expect(applySatisfies('zone-apply', 'redeploy')).toBe(false);
  });

  it('keeps every apply short of a datastore reset off it', () => {
    for (const c of CLASSES.filter((k) => k !== 'datastore-reset')) {
      expect(applySatisfies(c, 'datastore-reset')).toBe(false);
    }
  });

  it('reaches everything from a datastore reset', () => {
    for (const c of CLASSES) expect(applySatisfies('datastore-reset', c)).toBe(true);
  });

  it('never claims to satisfy a class that outranks the performed one', () => {
    for (const performed of CLASSES) {
      for (const reached of APPLY_SATISFIES[performed]) {
        expect(APPLY_CLASS_RANK[reached as ApplyClass]).toBeLessThanOrEqual(APPLY_CLASS_RANK[performed]);
      }
    }
  });
});
