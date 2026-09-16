import { describe, expect, it } from 'vitest';

import { APPLY_CLASS_PREFIXES, applyClassFor, strongestApplyClass } from './apply-class';
import { APPLY_CLASS_RANK, ApplyClassSchema } from './schemas/stack';

describe('applyClassFor', () => {
  it('reads a port and the lan toggle as a recreate, because both move a binding', () => {
    expect(applyClassFor('ports.postgres')).toBe('rebind-recreate');
    expect(applyClassFor('lan.expose')).toBe('rebind-recreate');
  });

  it('prices every lan knob, not just the deprecated boolean', () => {
    for (const path of ['lan.mode', 'lan.bindAddress', 'lan.datastoreAuth']) {
      expect(applyClassFor(path)).toBe('rebind-recreate');
    }
  });

  it('splits the two datastore credentials off the reset the postgres identity costs', () => {
    expect(applyClassFor('identity.pg.password')).toBe('datastore-reset');
    expect(applyClassFor('identity.redis.password')).toBe('redeploy');
    expect(applyClassFor('identity.mailpit.password')).toBe('redeploy');
  });

  it('splits the two service reloads by which process reads the knob', () => {
    expect(applyClassFor('stackDefaults.hub.LOG_LEVEL')).toBe('reload-hub');
    expect(applyClassFor('stackDefaults.spoke.BRIDGE_SYNC_ENABLED')).toBe('reload-spoke');
  });

  it('splits a zone change off the rest of the fleet, because the seed order differs', () => {
    expect(applyClassFor('fleet.zones.edge')).toBe('zone-apply');
    expect(applyClassFor('fleet.zones."sim-zone".bridges')).toBe('zone-apply');
    expect(applyClassFor('fleet.autoStart')).toBe('fleet-op');
    expect(applyClassFor('fleet.defaults.cpus')).toBe('fleet-op');
  });

  it('reads an identity change as a datastore reset, since initialDatabases runs once', () => {
    expect(applyClassFor('identity.pg.user')).toBe('datastore-reset');
    expect(applyClassFor('identity.orgId')).toBe('datastore-reset');
  });

  it('lets the longer prefix win over the namespace it sits in', () => {
    expect(applyClassFor('stack.slot')).toBe('reslot');
    expect(applyClassFor('telemetry.enable')).toBe('auto');
  });

  it('returns null for a path no rule owns, rather than guessing a cost', () => {
    expect(applyClassFor('remoteInfra.enable')).toBeNull();
    expect(applyClassFor('')).toBeNull();
  });

  it('carries no cost for a read-only path, which no save can reach', () => {
    expect(applyClassFor('zoneCrypto.hubPrivateKey')).toBeNull();
    expect(applyClassFor('zoneCrypto.bridgeAtRestKey')).toBeNull();
    expect(applyClassFor('polyrepo.hub.path')).toBeNull();
    expect(applyClassFor('polyrepo.hub.url')).toBeNull();
  });

  it('names every class it can return, so no rule points at an unranked one', () => {
    const reachable = new Set(APPLY_CLASS_PREFIXES.map((p) => applyClassFor(p)));
    for (const cls of reachable) {
      expect(cls).not.toBeNull();
      if (cls) expect(ApplyClassSchema.options).toContain(cls);
    }
  });
});

describe('strongestApplyClass', () => {
  it('reports nothing for an empty change set', () => {
    expect(strongestApplyClass([])).toBeNull();
  });

  it('reports the strongest, not the first or the last', () => {
    expect(strongestApplyClass(['reload-hub', 'rebind-recreate', 'auto'])).toBe('rebind-recreate');
    expect(strongestApplyClass(['rebind-recreate', 'reload-hub'])).toBe('rebind-recreate');
  });

  it('lets a reset outrank everything, because no button performs it', () => {
    const all = ApplyClassSchema.options.filter((c) => c !== 'datastore-reset');
    expect(strongestApplyClass([...all, 'datastore-reset'])).toBe('datastore-reset');
  });

  it('picks one of the two equal reloads rather than throwing', () => {
    const picked = strongestApplyClass(['reload-hub', 'reload-spoke']);
    expect(picked && APPLY_CLASS_RANK[picked]).toBe(APPLY_CLASS_RANK['reload-hub']);
  });
});

describe('every declared class is reachable', () => {
  it('declares no class the rules can never return, which would be dead vocabulary', () => {
    const reachable = new Set(APPLY_CLASS_PREFIXES.map((p) => applyClassFor(p)));
    expect(ApplyClassSchema.options.filter((c) => !reachable.has(c))).toEqual([]);
  });
});

describe('applyClassFor — the advanced families', () => {
  it('classifies every writable behavioural fork the advanced page can hold', () => {
    const forks = ['redisAcl.enable', 'vrrpSim.enable', 'spoke.watch', 'stack.fleetNodeCount'];
    expect(forks.filter((path) => applyClassFor(path) === null)).toEqual([]);
  });

  it('reads a spoke knob no reader consumes as inert, not as a spoke reload', () => {
    expect(applyClassFor('stackDefaults.spoke.AGENT_SSH_FORCE_REDEPLOY')).toBe('inert');
    expect(applyClassFor('stackDefaults.spoke.ANALYTICS_ENABLED')).toBe('inert');
  });

  it('keeps spoke.watch off the bare spoke rule, which belongs to the env knobs', () => {
    expect(applyClassFor('spoke.watch')).toBe('redeploy');
    expect(applyClassFor('stackDefaults.spoke.LOG_LEVEL')).toBe('reload-spoke');
  });
});

describe('applyClassFor — a value that reaches a process through a nix store path', () => {
  it('does not read osLayerCache as a redeploy, because a restart re-reads the same store file', () => {
    expect(applyClassFor('osLayerCache.resolvers')).not.toBe('redeploy');
    expect(applyClassFor('osLayerCache.originHost')).not.toBe('redeploy');
  });

  it('reads it strongly enough to force the recreation the new value needs', () => {
    expect(APPLY_CLASS_RANK[applyClassFor('osLayerCache.resolvers')!]).toBeGreaterThanOrEqual(
      APPLY_CLASS_RANK['rebind-recreate'],
    );
  });
});
