import { isAppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';

import { contract } from './index';
import {
  APPLY_CLASS_RANK,
  ApplyClassSchema,
  ConfigTreeEntrySchema,
  RESTART_STALE_AFTER_LABEL,
  RESTART_STALE_AFTER_MS,
  RestartStatusSchema,
  ServicePortSchema,
  StackConfigSchema,
  StackKnobSchema,
  StackPendingSchema,
} from './schemas/stack';

describe('RESTART_STALE_AFTER_MS', () => {
  it('is the 30-minute bound both processes apply', () => {
    expect(RESTART_STALE_AFTER_MS).toBe(30 * 60 * 1000);
    expect(RESTART_STALE_AFTER_LABEL).toBe('30 minutes');
  });

  it('derives the status description, so the prose cannot drift from the number', () => {
    expect(RestartStatusSchema.description).toContain(`past ${RESTART_STALE_AFTER_LABEL}`);
  });

  it('derives the endpoint description too', () => {
    expect(contract.getRestartState.description).toContain(`past ${RESTART_STALE_AFTER_LABEL}`);
  });

  it('hard-codes no other minute count in either description', () => {
    for (const prose of [RestartStatusSchema.description, contract.getRestartState.description]) {
      expect([...(prose ?? '').matchAll(/(\d+) minutes/g)].map((m) => m[1])).toEqual(['30']);
    }
  });
});

describe('RestartStatusSchema', () => {
  it('is the only discriminant, with no boolean twin on the state shape', () => {
    expect(RestartStatusSchema.options).toEqual(['idle', 'pending', 'stale', 'failed']);
    const shape = Object.keys(contract.getRestartState.responses[200].shape);
    expect(shape).toContain('status');
    expect(shape).not.toContain('pending');
    expect(shape).not.toContain('stale');
    expect(shape).not.toContain('failed');
  });
});

describe('StackKnobSchema', () => {
  const knob = {
    path: 'stackDefaults.hub.LOG_LEVEL',
    env: 'LOG_LEVEL',
    label: 'Log level',
    default: 'debug',
    kind: 'select' as const,
    group: 'Logging',
    writable: true,
  };

  it('parses a knob that carries neither source nor pinnedBy', () => {
    expect(StackKnobSchema.parse(knob)).toEqual(knob);
  });

  it('parses a knob carrying both', () => {
    expect(StackKnobSchema.parse({ ...knob, source: 'nix', pinnedBy: 'BROKKR_HUB_LOG_LEVEL' })).toMatchObject({
      source: 'nix',
      pinnedBy: 'BROKKR_HUB_LOG_LEVEL',
    });
  });

  it('accepts every declared source and rejects an undeclared one', () => {
    for (const source of ['nix', 'derived', 'lab']) {
      expect(StackKnobSchema.parse({ ...knob, source }).source).toBe(source);
    }
    expect(() => StackKnobSchema.parse({ ...knob, source: 'overlay' })).toThrow();
  });

  it('describes both new fields', () => {
    expect(StackKnobSchema.shape.source.description).toBeTruthy();
    expect(StackKnobSchema.shape.pinnedBy.description).toBeTruthy();
  });
});

describe('ApplyClassSchema', () => {
  it('ranks every class it declares, so a new one cannot arrive unranked', () => {
    expect(Object.keys(APPLY_CLASS_RANK).sort()).toEqual([...ApplyClassSchema.options].sort());
  });

  it('ranks a recreate above a redeploy, and a reset above everything', () => {
    expect(APPLY_CLASS_RANK['rebind-recreate']).toBeGreaterThan(APPLY_CLASS_RANK.redeploy);
    expect(APPLY_CLASS_RANK.reslot).toBeGreaterThan(APPLY_CLASS_RANK['rebind-recreate']);
    const highest = Math.max(...Object.values(APPLY_CLASS_RANK));
    expect(APPLY_CLASS_RANK['datastore-reset']).toBe(highest);
  });

  it('ranks the two reloads equally, because neither subsumes the other', () => {
    expect(APPLY_CLASS_RANK['reload-hub']).toBe(APPLY_CLASS_RANK['reload-spoke']);
  });

  it('ranks an inert path below one that applies on save', () => {
    expect(APPLY_CLASS_RANK.inert).toBeLessThan(APPLY_CLASS_RANK.auto);
  });
});

describe('putStackConfig entries', () => {
  const body = () => {
    const route = contract.putStackConfig;
    if (!isAppRoute(route) || !route.body) throw new Error('putStackConfig body missing');
    return route.body;
  };

  it('tells an untouched path from one being reverted', () => {
    const parsed = body().parse({ entries: { 'ports.postgres': null } });
    expect(Object.hasOwn(parsed.entries, 'ports.postgres')).toBe(true);
    expect(parsed.entries['ports.postgres']).toBeNull();
    expect(Object.hasOwn(body().parse({ entries: {} }).entries, 'ports.postgres')).toBe(false);
  });

  it('carries a set value as the string the writer coerces', () => {
    expect(body().parse({ entries: { 'stackDefaults.hub.LOG_LEVEL': 'warn' } }).entries).toEqual({
      'stackDefaults.hub.LOG_LEVEL': 'warn',
    });
  });

  it('keeps an empty string, which is a value rather than a revert', () => {
    expect(body().parse({ entries: { 'osLayerCache.resolvers': '' } }).entries['osLayerCache.resolvers']).toBe('');
  });

  it('refuses a body with no entries map at all', () => {
    expect(() => body().parse({})).toThrow();
  });
});

describe('ConfigTreeEntrySchema', () => {
  const entry = {
    path: 'stackDefaults.hub.HUB_REPO_PATH',
    label: 'Hub repo path',
    group: 'Location',
    description: 'Where the hub checkout lives',
    value: null,
    default: null,
    definedIn: [],
    secret: false,
    overridden: false,
    writable: true,
    kind: 'text' as const,
    choices: [] as string[],
    danger: false,
    applyClass: 'reload-hub' as const,
  };

  it('keeps a declared-but-unset value as null rather than an empty string', () => {
    expect(ConfigTreeEntrySchema.parse(entry).value).toBeNull();
    expect(ConfigTreeEntrySchema.parse(entry).default).toBeNull();
  });

  it('accepts a tri-state overridden, so an undeterminable row is expressible', () => {
    expect(ConfigTreeEntrySchema.parse({ ...entry, overridden: null }).overridden).toBeNull();
    expect(ConfigTreeEntrySchema.parse({ ...entry, overridden: true }).overridden).toBe(true);
  });

  it('carries comparison-only digests for a secret and omits them otherwise', () => {
    const parsed = ConfigTreeEntrySchema.parse({
      ...entry,
      secret: true,
      value: '***',
      default: '***',
      overridden: true,
      valueDigest: '***sha256:1f4a9c2e (len 8)',
      defaultDigest: '***sha256:00000000 (len 4)',
    });
    expect(parsed.valueDigest).not.toEqual(parsed.defaultDigest);
    expect(ConfigTreeEntrySchema.parse(entry).valueDigest).toBeUndefined();
  });

  it('requires an apply class, so no row can be saved unclassified', () => {
    const { applyClass, ...without } = entry;
    void applyClass;
    expect(() => ConfigTreeEntrySchema.parse(without)).toThrow();
  });
});

describe('ServicePortSchema', () => {
  it('carries the group and the canonical path Nix declares', () => {
    const port = { key: 'postgres', path: 'ports.postgres', group: 'Datastores', label: 'Postgres', value: 5432 };
    expect(ServicePortSchema.parse(port)).toMatchObject({ group: 'Datastores', path: 'ports.postgres' });
    const { group, ...noGroup } = port;
    void group;
    expect(() => ServicePortSchema.parse(noGroup)).toThrow();
  });
});

describe('StackPendingSchema', () => {
  it('reports a clean stack with no strongest class rather than a placeholder one', () => {
    const parsed = StackPendingSchema.parse({
      seeded: true,
      savedNotApplied: { paths: [], classes: [] },
      strongestClass: null,
      rebindArmed: false,
      restart: { status: 'idle' },
      resetRequired: [],
      unknownSince: null,
      zoneSteps: [],
    });
    expect(parsed.strongestClass).toBeNull();
  });

  it('refuses a payload that omits the foreign-write answer, so it cannot default to clean', () => {
    expect(() =>
      StackPendingSchema.parse({
        seeded: true,
        savedNotApplied: { paths: [], classes: [] },
        strongestClass: null,
        rebindArmed: false,
        restart: { status: 'idle' },
        resetRequired: [],
      }),
    ).toThrow();
  });

  it('names the paths a reset covers, separately from the pending set they sit in', () => {
    const parsed = StackPendingSchema.parse({
      seeded: true,
      savedNotApplied: { paths: ['identity.pg.user'], classes: ['datastore-reset'] },
      strongestClass: 'datastore-reset',
      rebindArmed: false,
      restart: { status: 'idle' },
      resetRequired: ['identity.pg.user'],
      unknownSince: null,
      zoneSteps: [],
    });
    expect(parsed.resetRequired).toEqual(['identity.pg.user']);
  });
});

describe('StackConfigSchema topology', () => {
  it('measures rather than requests, so no caller can ask for a count', () => {
    const shape = Object.keys(StackConfigSchema.shape);
    expect(shape).toContain('topology');
    expect(shape).not.toContain('counts');
  });

  it('requires both measured numbers, so a partial reading cannot pass as complete', () => {
    expect(() => StackConfigSchema.shape.topology.parse({ zones: 1 })).toThrow();
    expect(StackConfigSchema.shape.topology.parse({ zones: 2, bridges: 3 })).toEqual({ zones: 2, bridges: 3 });
  });

  it('accepts zero of each, because an unseeded stack has measured nothing yet', () => {
    expect(StackConfigSchema.shape.topology.parse({ zones: 0, bridges: 0 })).toEqual({ zones: 0, bridges: 0 });
  });
});

describe('ConfigTreeEntrySchema — the widget the page needs', () => {
  const base = {
    path: 'redisAcl.enable',
    label: 'Per-zone Redis ACLs',
    group: 'Security',
    description: 'why',
    value: 'true',
    default: 'true',
    definedIn: [],
    secret: false,
    overridden: false,
    writable: true,
    kind: 'bool' as const,
    choices: [] as string[],
    danger: false,
    applyClass: 'redeploy' as const,
  };

  it('carries the kind, so no page re-derives a widget from the value', () => {
    expect(ConfigTreeEntrySchema.parse(base).kind).toBe('bool');
    expect(() => ConfigTreeEntrySchema.parse({ ...base, kind: 'slider' })).toThrow();
  });

  it('requires the kind, because guessing one renders the wrong control silently', () => {
    const { kind, ...without } = base;
    void kind;
    expect(() => ConfigTreeEntrySchema.parse(without)).toThrow();
  });

  it('carries the danger flag, so a marked knob stays marked whatever else the row says', () => {
    expect(ConfigTreeEntrySchema.parse({ ...base, danger: true }).danger).toBe(true);
  });

  it('carries the choices a select needs and an empty list for every other kind', () => {
    expect(ConfigTreeEntrySchema.parse({ ...base, kind: 'select', choices: ['a', 'b'] }).choices).toEqual(['a', 'b']);
    expect(ConfigTreeEntrySchema.parse(base).choices).toEqual([]);
  });
});
