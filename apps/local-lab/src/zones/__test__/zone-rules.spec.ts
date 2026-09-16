import { describe, expect, it } from 'vitest';

import { procNameOf, zoneRefusal, type ZoneRulesInput } from '../zone-rules';

const input = (over: Partial<ZoneRulesInput> = {}): ZoneRulesInput => ({
  desired: [{ name: 'sim-zone', index: 0, bridges: 1 }],
  declared: [{ name: 'sim-zone', index: 0, bridges: 1 }],
  nodeZones: {},
  nodesByZone: {},
  occupancyByZone: {},
  rename: undefined,
  capacity: 25,
  hubZoneNames: ['sim-zone'],
  ...over,
});

describe('zoneRefusal — the rules the engine enforces at load', () => {
  it('accepts the base single zone unchanged', () => {
    expect(zoneRefusal(input())).toBeNull();
  });

  it('refuses a duplicate name', () => {
    const desired = [
      { name: 'edge', index: 0, bridges: 1 },
      { name: 'edge', index: 1, bridges: 1 },
    ];
    expect(zoneRefusal(input({ desired, declared: [] }))).toMatch(/duplicate zone name: edge/);
  });

  it('refuses a duplicate index, which would collide two zone uuids', () => {
    const desired = [
      { name: 'a', index: 1, bridges: 1 },
      { name: 'b', index: 1, bridges: 1 },
    ];
    expect(zoneRefusal(input({ desired, declared: [] }))).toMatch(/duplicate zone index: 1/);
  });

  it('refuses an index outside the range the uuid derivation covers', () => {
    const desired = [{ name: 'a', index: 89, bridges: 1 }];
    expect(zoneRefusal(input({ desired, declared: [] }))).toMatch(/outside 0\.\.88/);
  });

  it('refuses a node naming a zone nothing declares', () => {
    expect(zoneRefusal(input({ nodeZones: { 'cpu-1': 'ghost' } }))).toMatch(/zone ghost is not a declared zone/);
  });

  it('refuses leaving a node without a zone once two are declared', () => {
    const desired = [
      { name: 'sim-zone', index: 0, bridges: 1 },
      { name: 'edge', index: 1, bridges: 1 },
    ];
    const refusal = zoneRefusal(
      input({ desired, nodesByZone: { 'sim-zone': ['cpu-1', 'cpu-2'] }, nodeZones: { 'cpu-1': 'sim-zone' } }),
    );
    expect(refusal).toMatch(/every node must name a zone/);
    expect(refusal).toMatch(/cpu-2/);
  });

  it('accepts a single-zone fleet whose nodes name nothing, which is the legacy shape', () => {
    expect(zoneRefusal(input({ nodesByZone: { 'sim-zone': ['cpu-1'] } }))).toBeNull();
  });
});

describe('zoneRefusal — the rules only the control center can see', () => {
  it('refuses removing a zone that still owns nodes, and names them', () => {
    const declared = [
      { name: 'sim-zone', index: 0, bridges: 1 },
      { name: 'edge', index: 1, bridges: 1 },
    ];
    const refusal = zoneRefusal(
      input({
        declared,
        nodesByZone: { edge: ['gpu-1'] },
        occupancyByZone: { edge: ['gpu-1'] },
        nodeZones: { 'gpu-1': 'edge' },
      }),
    );
    expect(refusal).toMatch(/zone edge still owns 1 node\(s\) \(gpu-1\)/);
  });

  it('refuses removing a zone whose only occupant is a bare-metal machine', () => {
    const declared = [
      { name: 'sim-zone', index: 0, bridges: 1 },
      { name: 'edge', index: 1, bridges: 1 },
    ];
    expect(zoneRefusal(input({ declared, occupancyByZone: { edge: ['metal-1'] } }))).toMatch(
      /zone edge still owns 1 node\(s\) \(metal-1\)/,
    );
  });

  it('accepts a second zone while a bare-metal machine occupies one of them', () => {
    const desired = [
      { name: 'sim-zone', index: 0, bridges: 1 },
      { name: 'edge', index: 1, bridges: 1 },
    ];
    const refusal = zoneRefusal(
      input({
        desired,
        nodesByZone: { 'sim-zone': ['cpu-1'] },
        occupancyByZone: { 'sim-zone': ['cpu-1'], edge: ['metal-1'] },
        nodeZones: { 'cpu-1': 'sim-zone' },
      }),
    );
    expect(refusal).toBeNull();
  });

  it('allows removing a zone that owns none', () => {
    const declared = [
      { name: 'sim-zone', index: 0, bridges: 1 },
      { name: 'edge', index: 1, bridges: 1 },
    ];
    expect(zoneRefusal(input({ declared }))).toBeNull();
  });

  it('refuses the reserved fixture name', () => {
    const desired = [{ name: 'sim-zone-maintenance', index: 0, bridges: 1 }];
    expect(zoneRefusal(input({ desired, declared: [] }))).toMatch(/seeded as a hub fixture/);
  });

  it('refuses a zone whose derived process name collides with a replica of zone 0', () => {
    const desired = [
      { name: 'sim-zone', index: 0, bridges: 2 },
      { name: '1', index: 1, bridges: 1 },
    ];
    expect(zoneRefusal(input({ desired, declared: [] }))).toMatch(/both be called spoke-1/);
  });

  it('refuses more bridges than the ordinal budget holds, naming both numbers', () => {
    const desired = [{ name: 'sim-zone', index: 0, bridges: 30 }];
    const refusal = zoneRefusal(input({ desired, capacity: 25 }));
    expect(refusal).toMatch(/30 bridges exceed the 25 ordinals/);
  });

  it('checks no budget when nix reported none, rather than refusing everything', () => {
    const desired = [{ name: 'sim-zone', index: 0, bridges: 30 }];
    expect(zoneRefusal(input({ desired, capacity: 0 }))).toBeNull();
  });
});

describe('zoneRefusal — rename', () => {
  const renameInput = (over: Partial<ZoneRulesInput> = {}) =>
    input({
      desired: [{ name: 'edge', index: 0, bridges: 1 }],
      declared: [{ name: 'sim-zone', index: 0, bridges: 1 }],
      rename: { from: 'sim-zone', to: 'edge' },
      hubZoneNames: ['sim-zone'],
      ...over,
    });

  it('allows a rename at a fixed index, because the hub row upserts by id', () => {
    expect(zoneRefusal(renameInput())).toBeNull();
  });

  it('refuses a rename combined with an index move, and says why it cannot be told apart', () => {
    const refusal = zoneRefusal(renameInput({ desired: [{ name: 'edge', index: 2, bridges: 1 }] }));
    expect(refusal).toMatch(/two saves/);
  });

  it('refuses renaming a zone nothing declares', () => {
    expect(zoneRefusal(renameInput({ rename: { from: 'ghost', to: 'edge' } }))).toMatch(/no zone by that name/);
  });

  it('refuses a rename whose target the set does not declare', () => {
    expect(zoneRefusal(renameInput({ rename: { from: 'sim-zone', to: 'other' } }))).toMatch(/must also declare it/);
  });

  it('refuses a target name the hub already holds, since Zone.name has no unique index', () => {
    expect(zoneRefusal(renameInput({ hubZoneNames: ['sim-zone', 'edge'] }))).toMatch(
      /already has a Zone row named edge/,
    );
  });

  it('does not treat the renamed-away zone as a removal that owns nodes', () => {
    expect(
      zoneRefusal(
        renameInput({
          nodesByZone: { 'sim-zone': ['cpu-1'] },
          occupancyByZone: { 'sim-zone': ['cpu-1'] },
          nodeZones: { 'cpu-1': 'edge' },
        }),
      ),
    ).toBeNull();
  });
});

describe('procNameOf', () => {
  it('keeps the bare name for the primary bridge of zone 0', () => {
    expect(procNameOf({ name: 'sim-zone', index: 0 }, 0)).toBe('spoke');
    expect(procNameOf({ name: 'sim-zone', index: 0 }, 1)).toBe('spoke-1');
  });

  it('suffixes every other zone by name, which is what makes a numeric name collide', () => {
    expect(procNameOf({ name: 'edge', index: 1 }, 0)).toBe('spoke-edge');
    expect(procNameOf({ name: 'edge', index: 1 }, 2)).toBe('spoke-edge-2');
    expect(procNameOf({ name: '1', index: 1 }, 0)).toBe('spoke-1');
  });
});

describe('zone name charset', () => {
  it('refuses a name that would traverse out of the token directory', () => {
    expect(zoneRefusal(input({ desired: [{ name: '../escape', index: 0, bridges: 1 }] }))).toMatch(/token filename/);
  });

  it('refuses a name that would corrupt the redis acl password in the dsn', () => {
    expect(zoneRefusal(input({ desired: [{ name: 'a@b', index: 0, bridges: 1 }] }))).toMatch(/redis acl password/);
  });
});
