import { describe, expect, it } from 'vitest';

import { ApplyClassSchema, type FleetPending, type StackPending } from '@/contract';
import { applyCosts, applyRows } from './apply-model';

const pending = (over: Partial<StackPending> = {}): StackPending => ({
  seeded: true,
  savedNotApplied: { paths: [], classes: [] },
  strongestClass: null,
  rebindArmed: false,
  restart: { status: 'idle' },
  resetRequired: [],
  unknownSince: null,
  zoneSteps: [],
  ...over,
});

const fleet = (over: Partial<FleetPending> = {}): FleetPending =>
  ({
    inSync: false,
    severity: 'hot-appliable',
    desiredDigest: 'a',
    appliedDigest: 'b',
    appliedAt: null,
    summary: { added: 2, removed: 0, changed: 1, unchanged: 3 },
    nodes: { added: [], removed: [], changed: [] },
    network: { changed: false },
    note: null,
    ...over,
  }) as FleetPending;

describe('applyCosts', () => {
  it('names a cost for every class the contract declares', () => {
    for (const cls of ApplyClassSchema.options) expect(applyCosts([cls])).toHaveLength(1);
    for (const cls of ApplyClassSchema.options) expect(applyCosts([cls])[0]).toBeTruthy();
  });

  it('answers an empty list for no class rather than a blank entry', () => {
    expect(applyCosts([])).toEqual([]);
  });

  it('keeps both tied reloads, since neither dominates the other', () => {
    expect(applyCosts(['reload-hub', 'reload-spoke'])).toEqual(['needs a hub reload', 'needs a spoke reload']);
  });

  it('collapses a repeated class and orders the rest strongest first', () => {
    expect(applyCosts(['reload-hub', 'redeploy', 'reload-hub'])).toEqual(['needs a redeploy', 'needs a hub reload']);
  });
});

describe('applyRows', () => {
  it('renders nothing on a clean stack', () => {
    expect(applyRows({ pending: pending() })).toEqual([]);
  });

  it('renders nothing when the pending state could not be read', () => {
    expect(applyRows({ pending: null })).toEqual([]);
  });

  it('renders nothing when the seed failed, since every value below is a bare default', () => {
    expect(applyRows({ pending: pending({ seeded: false, savedNotApplied: { paths: ['x'], classes: [] } }) })).toEqual(
      [],
    );
  });

  it('gives each class its own row, and names the action that clears it', () => {
    const rows = applyRows({
      pending: pending({
        savedNotApplied: {
          paths: ['stackDefaults.hub.LOG_LEVEL', 'stackDefaults.spoke.LOG_LEVEL'],
          classes: ['reload-hub', 'reload-spoke'],
        },
      }),
    });

    expect(rows.map((r) => r.id)).toEqual(['reload-hub', 'reload-spoke']);
    expect(rows[0].action).toEqual({ kind: 'reload', group: 'hub' });
    expect(rows[1].action).toEqual({ kind: 'reload', group: 'spoke' });
  });

  it('orders the rows strongest first, so the costliest apply is read before the cheapest', () => {
    const rows = applyRows({
      pending: pending({
        savedNotApplied: {
          paths: ['stackDefaults.hub.LOG_LEVEL', 'ports.postgres'],
          classes: ['reload-hub', 'rebind-recreate'],
        },
      }),
    });

    expect(rows.map((r) => r.id)).toEqual(['rebind-recreate', 'reload-hub']);
  });

  it('offers the reinit op for a datastore reset, marked destructive', () => {
    const rows = applyRows({
      pending: pending({
        savedNotApplied: { paths: ['identity.pg.user'], classes: ['datastore-reset'] },
        resetRequired: ['identity.pg.user'],
      }),
    });

    expect(rows[0].action).toEqual({ kind: 'stack-op', opId: 'reinit' });
    expect(rows[0].destructive).toBe(true);
  });

  it('offers no action for a path no rule owns, rather than guessing one', () => {
    const rows = applyRows({ pending: pending({ savedNotApplied: { paths: ['nothing.owns.this'], classes: [] } }) });

    expect(rows.map((r) => r.id)).toEqual(['unclassified']);
    expect(rows[0].action).toBeNull();
  });

  it('gives the armed latch its own row when no recreate row already carries it', () => {
    const rows = applyRows({ pending: pending({ rebindArmed: true }) });

    expect(rows.map((r) => r.id)).toEqual(['rebind']);
    expect(rows[0].action).toEqual({ kind: 'redeploy' });
  });

  it('does not repeat the latch when a recreate row already demands the same run', () => {
    const rows = applyRows({
      pending: pending({
        rebindArmed: true,
        savedNotApplied: { paths: ['ports.postgres'], classes: ['rebind-recreate'] },
      }),
    });

    expect(rows.map((r) => r.id)).toEqual(['rebind-recreate']);
  });

  it('names a foreign overlay write and offers the safe run for it', () => {
    const rows = applyRows({ pending: pending({ unknownSince: '2026-08-23T10:00:00.000Z' }) });

    expect(rows.map((r) => r.id)).toEqual(['unknown']);
    expect(rows[0].detail).toContain('2026-08-23T10:00:00.000Z');
    expect(rows[0].action).toEqual({ kind: 'redeploy' });
  });

  it('names a failed recreation without offering a run that would hide it', () => {
    const rows = applyRows({ pending: pending({ restart: { status: 'failed' } }) });

    expect(rows.map((r) => r.id)).toEqual(['restart']);
    expect(rows[0].action).toBeNull();
  });

  it('leaves an idle restart out entirely', () => {
    expect(applyRows({ pending: pending({ restart: { status: 'idle' } }) })).toEqual([]);
  });

  it('carries the zone steps on the zone row, so a refresh cannot lose the order', () => {
    const steps = [{ id: 'sim:seed', label: 'Seed the hub zone', why: 'the uuid derives from the index' }];
    const rows = applyRows({
      pending: pending({
        savedNotApplied: { paths: ['fleet.zones.edge'], classes: ['zone-apply'] },
        zoneSteps: steps,
      }),
    });

    expect(rows.map((r) => r.id)).toEqual(['zone-apply']);
    expect(rows[0].action).toEqual({ kind: 'stack-op', opId: 'zone-seed' });
    expect(rows[0].steps).toEqual(steps);
  });

  it('leaves the zone steps off a row they do not describe', () => {
    const rows = applyRows({
      pending: pending({
        savedNotApplied: { paths: ['stackDefaults.hub.LOG_LEVEL'], classes: ['reload-hub'] },
        zoneSteps: [{ id: 'sim:seed', label: 'x', why: 'y' }],
      }),
    });

    expect(rows[0].steps).toEqual([]);
  });

  it('adds a fleet row from the engine, with the fleet-apply op', () => {
    const rows = applyRows({ pending: pending(), fleet: fleet() });

    expect(rows.map((r) => r.id)).toEqual(['fleet']);
    expect(rows[0].detail).toBe('2 added, 1 changed');
    expect(rows[0].action).toEqual({ kind: 'stack-op', opId: 'fleet-apply' });
  });

  it('routes a plane change to its own op, and marks it destructive', () => {
    const rows = applyRows({ pending: pending(), fleet: fleet({ severity: 'planes-change' }) });

    expect(rows[0].id).toBe('fleet-planes');
    expect(rows[0].detail).toBe('the desired fleet planes differ from the applied ones');
    expect(rows[0].action).toEqual({ kind: 'stack-op', opId: 'fleet-planes-apply' });
    expect(rows[0].destructive).toBe(true);
  });

  it('routes a stale iPXE bake to the fleet apply, whose rebake step re-bakes', () => {
    const rows = applyRows({ pending: pending(), fleet: fleet({ severity: 'stale-bake' }) });

    expect(rows[0].id).toBe('fleet-bake');
    expect(rows[0].action).toEqual({ kind: 'stack-op', opId: 'fleet-apply' });
    expect(rows[0].cost).toBe('needs a fleet apply, which re-bakes iPXE');
    expect(rows[0].destructive).toBe(false);
  });

  it('shows the server note for a stale bake rather than the topology counts', () => {
    const note = 'the iPXE bake names http://198.51.100.9:8000, but this stack serves http://198.51.100.14:8000';
    const rows = applyRows({ pending: pending(), fleet: fleet({ severity: 'stale-bake', note }) });

    expect(rows[0].detail).toBe(note);
  });

  it('leaves an in-sync fleet out', () => {
    expect(applyRows({ pending: pending(), fleet: fleet({ inSync: true }) })).toEqual([]);
  });

  it('blocks only the domain whose form is dirty', () => {
    const rows = applyRows({
      pending: pending({ savedNotApplied: { paths: ['stackDefaults.hub.LOG_LEVEL'], classes: ['reload-hub'] } }),
      fleet: fleet(),
      dirtyDomain: 'stack',
    });

    expect(rows.find((r) => r.id === 'reload-hub')?.blockedBy).toBe('save first');
    expect(rows.find((r) => r.id === 'fleet')?.blockedBy).toBeNull();
  });
});
