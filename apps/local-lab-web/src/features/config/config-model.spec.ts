import { describe, expect, it } from 'vitest';

import type { ConfigTreeEntry } from '@/contract';

import { changedBySection, overriddenByArea, overriddenCount, sourceSummary } from './config-model';
import { AREA_SECTIONS } from './knob-location';

const entry = (over: Partial<ConfigTreeEntry> & { path: string }): ConfigTreeEntry => {
  const base: ConfigTreeEntry = {
    label: 'Label',
    group: 'Group',
    description: 'Why this knob exists.',
    value: 'same',
    default: 'same',
    definedIn: [],
    secret: false,
    overridden: false,
    writable: true,
    kind: 'text',
    choices: [],
    danger: false,
    applyClass: 'reload-hub',
    ...over,
  };
  return { ...base, overridden: over.overridden ?? base.value !== base.default };
};

describe('overriddenByArea', () => {
  it('lists only knobs whose value differs from the declared default', () => {
    const rows = overriddenByArea([
      entry({ path: 'stackDefaults.hub.LOG_LEVEL', value: 'warn', default: 'debug' }),
      entry({ path: 'stackDefaults.spoke.LOG_LEVEL' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].rows.map((r) => r.entry.path)).toEqual(['stackDefaults.hub.LOG_LEVEL']);
  });

  it('groups by the page that owns the field and carries its route and anchor', () => {
    const rows = overriddenByArea([
      entry({ path: 'stackDefaults.hub.LOG_LEVEL', value: 'warn', default: 'debug' }),
      entry({ path: 'fleet.autoStart', value: 'false', default: 'true' }),
    ]);
    expect(rows.map((r) => r.area)).toEqual(['stack', 'fleet']);
    expect(rows[0].rows[0]).toMatchObject({
      route: '/config/stack',
      anchor: 'cfg-stackDefaults-hub-LOG_LEVEL',
    });
  });

  it('drops a path no editor owns rather than linking it nowhere', () => {
    expect(overriddenByArea([entry({ path: 'remoteInfra.enable', value: 'false', default: 'true' })])).toEqual([]);
  });

  it('groups a behavioural fork under advanced, now that the page owns it', () => {
    const rows = overriddenByArea([entry({ path: 'redisAcl.enable', value: 'false', default: 'true' })]);
    expect(rows.map((r) => r.area)).toEqual(['advanced']);
  });

  it('reports a pinned knob against the variable that holds it', () => {
    const rows = overriddenByArea([
      entry({ path: 'stackDefaults.hub.LOG_LEVEL', value: 'warn', default: 'debug', pinnedBy: 'BROKKR_LOG' }),
    ]);
    expect(rows[0].rows[0].source).toMatchObject({ kind: 'pin', label: '$BROKKR_LOG' });
  });
});

describe('sourceSummary', () => {
  it('counts the files and pins that define something, and omits defaults', () => {
    const summary = sourceSummary([
      entry({ path: 'stackDefaults.hub.A', value: 'x', default: 'y', definedIn: ['stack.local.nix'] }),
      entry({ path: 'stackDefaults.hub.B', value: 'x', default: 'y', definedIn: ['stack.local.nix'] }),
      entry({ path: 'stackDefaults.hub.C', value: 'x', default: 'y', definedIn: ['devenv.local.nix'] }),
      entry({ path: 'stackDefaults.hub.D' }),
    ]);
    expect(summary).toEqual([
      { label: 'stack.local.nix', kind: 'file', count: 2 },
      { label: 'devenv.local.nix', kind: 'file', count: 1 },
    ]);
  });

  it('names a hand-edited file the control center never writes', () => {
    const summary = sourceSummary([
      entry({
        path: 'stackDefaults.hub.A',
        value: 'x',
        default: 'y',
        definedIn: ['devenv/modules/hub.nix', 'devenv.local.nix'],
      }),
    ]);
    expect(summary[0].label).toBe('devenv.local.nix');
  });
});

describe('changedBySection', () => {
  it('keeps every declared section so the rail does not reflow when an override is reverted', () => {
    const sections = changedBySection([], 'stack');
    expect(sections.map((s) => s.section)).toEqual(AREA_SECTIONS.stack);
    expect(sections.every((s) => s.changed === 0)).toBe(true);
  });

  it('counts changes into the section that owns them', () => {
    const sections = changedBySection(
      [
        entry({ path: 'stackDefaults.hub.LOG_LEVEL', value: 'warn', default: 'debug' }),
        entry({ path: 'ports.postgres', value: '5442', default: '5432' }),
        entry({ path: 'ports.redis', value: '6380', default: '6379' }),
      ],
      'stack',
    );
    expect(sections.find((s) => s.section === 'HUB')?.changed).toBe(1);
    expect(sections.find((s) => s.section === 'PORTS')?.changed).toBe(2);
    expect(sections.find((s) => s.section === 'SPOKE')?.changed).toBe(0);
  });
});

describe('overriddenCount', () => {
  it('counts a secret the same way it counts anything else it can compare', () => {
    expect(overriddenCount([entry({ path: 'identity.pg.password', value: '***', default: '***', secret: true })])).toBe(
      0,
    );
  });
});
