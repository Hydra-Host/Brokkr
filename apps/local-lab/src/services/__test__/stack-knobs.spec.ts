import { describe, expect, it } from 'vitest';

import type { KnobCatalogEntry } from '../../common/pc-schemas';
import {
  catalogByPath,
  editablePortsFrom,
  envKnobPath,
  knobsFromCatalog,
  portDefaultsFromCatalog,
  readOnlyPortRows,
  readOnlyPortsFrom,
  servicePortRows,
} from '../stack-knobs';

const entry = (over: Partial<KnobCatalogEntry> & { path: string }): KnobCatalogEntry => ({
  label: 'Label',
  group: 'Group',
  description: 'Why this knob exists.',
  kind: 'text',
  choices: [],
  default: null,
  editable: true,
  danger: false,
  secret: false,
  alias: [],
  overrideFrom: null,
  ...over,
});

const CATALOG: KnobCatalogEntry[] = [
  entry({
    path: 'stackDefaults.hub.AUTH_BYPASS_ENABLED',
    label: 'Auth bypass',
    group: 'Security',
    kind: 'bool',
    danger: true,
    default: 'false',
    alias: ['LOCAL_SIMULATION_ENABLED', 'VITE_LOCAL_SIMULATION_ENABLED'],
    overrideFrom: 'stackOverrides.hub',
  }),
  entry({
    path: 'stackDefaults.hub.HUB_REPO_PATH',
    label: 'Hub repo path',
    group: 'Location',
    default: null,
    overrideFrom: 'stackOverrides.hub',
  }),
  entry({
    path: 'stackDefaults.spoke.LOG_LEVEL',
    label: 'Log level',
    group: 'Logging',
    kind: 'select',
    choices: ['debug', 'info', 'warning', 'error'],
    default: 'debug',
    overrideFrom: 'stackOverrides.spoke',
  }),
  entry({
    path: 'stackDefaults.spoke.LIFECYCLE_WORKER_CONCURRENCY',
    label: 'Lifecycle concurrency',
    group: 'Workers',
    kind: 'number',
    default: '10',
    overrideFrom: 'stackOverrides.spoke',
  }),
  entry({ path: 'ports.postgres', label: 'Postgres', group: 'Datastores', kind: 'port', default: 5432 }),
  entry({ path: 'ports.redis', label: 'Redis', group: 'Datastores', kind: 'port', default: 6379 }),
  entry({ path: 'lan.expose', label: 'LAN expose', group: 'Networking', kind: 'bool', default: false }),
];

describe('knobsFromCatalog — the catalog is the whole editable surface', () => {
  it('maps a catalog entry onto the contract shape', () => {
    expect(knobsFromCatalog('spoke', CATALOG, {}).find((k) => k.env === 'LOG_LEVEL')).toEqual({
      path: 'stackDefaults.spoke.LOG_LEVEL',
      env: 'LOG_LEVEL',
      writable: true,
      label: 'Log level',
      group: 'Logging',
      kind: 'select',
      default: 'debug',
      source: 'nix',
      info: 'Why this knob exists.',
      options: ['debug', 'info', 'warning', 'error'],
    });
  });

  it('offers the spoke the warning level the bridge honours, never warn', () => {
    expect(knobsFromCatalog('spoke', CATALOG, {}).find((k) => k.env === 'LOG_LEVEL')?.options).toContain('warning');
    expect(knobsFromCatalog('spoke', CATALOG, {}).find((k) => k.env === 'LOG_LEVEL')?.options).not.toContain('warn');
  });

  it('splits the groups on the catalog path, leaking no stackDefaults prefix', () => {
    expect(knobsFromCatalog('hub', CATALOG, {}).map((k) => k.env)).toEqual(['AUTH_BYPASS_ENABLED', 'HUB_REPO_PATH']);
    expect(knobsFromCatalog('spoke', CATALOG, {}).map((k) => k.env)).toEqual([
      'LOG_LEVEL',
      'LIFECYCLE_WORKER_CONCURRENCY',
    ]);
  });

  it('omits a knob the catalog does not carry', () => {
    const without = CATALOG.filter((e) => e.path !== 'stackDefaults.spoke.LOG_LEVEL');

    expect(knobsFromCatalog('spoke', without, {}).map((k) => k.env)).not.toContain('LOG_LEVEL');
  });

  it('omits a knob the catalog marks non-editable', () => {
    const locked = CATALOG.map((e) => (e.path === 'stackDefaults.spoke.LOG_LEVEL' ? { ...e, editable: false } : e));

    expect(knobsFromCatalog('spoke', locked, {}).map((k) => k.env)).toEqual(['LIFECYCLE_WORKER_CONCURRENCY']);
  });

  it('renders no knob at all from an empty catalog', () => {
    expect(knobsFromCatalog('hub', [], {})).toEqual([]);
  });

  it('marks a knob the catalog has no value for as lab-sourced', () => {
    const knob = knobsFromCatalog('hub', CATALOG, {}).find((k) => k.env === 'HUB_REPO_PATH');

    expect(knob).toMatchObject({ source: 'lab', default: null });
  });

  it('carries the danger flag and drops it where the catalog says false', () => {
    const hub = knobsFromCatalog('hub', CATALOG, {});

    expect(hub.find((k) => k.env === 'AUTH_BYPASS_ENABLED')?.danger).toBe(true);
    expect(hub.find((k) => k.env === 'HUB_REPO_PATH')).not.toHaveProperty('danger');
  });

  it('names the pinning variable on the pinned knob only', () => {
    const pins = { [envKnobPath('spoke', 'LOG_LEVEL')]: 'BROKKR_SPOKE_LOG_LEVEL' };
    const spoke = knobsFromCatalog('spoke', CATALOG, pins);

    expect(spoke.find((k) => k.env === 'LOG_LEVEL')?.pinnedBy).toBe('BROKKR_SPOKE_LOG_LEVEL');
    expect(spoke.find((k) => k.env === 'LIFECYCLE_WORKER_CONCURRENCY')).not.toHaveProperty('pinnedBy');
  });

  it('builds the pin key the catalog publishes', () => {
    expect(envKnobPath('hub', 'LOG_LEVEL')).toBe('stackDefaults.hub.LOG_LEVEL');
  });
});

describe('portDefaultsFromCatalog', () => {
  it('takes the pre-override port defaults and ignores every other path', () => {
    expect(portDefaultsFromCatalog(CATALOG)).toEqual({ postgres: 5432, redis: 6379 });
  });

  it('drops a port whose catalog default is out of range', () => {
    const bad = [entry({ path: 'ports.postgres', kind: 'port', default: 99999 })];

    expect(portDefaultsFromCatalog(bad)).toEqual({});
  });
});

describe('editablePortsFrom — keyed by portGroups.editable', () => {
  it('takes only the declared keys and coerces the eval strings', () => {
    const out = editablePortsFrom({ postgres: 5432, redis: 6379, grafana: 4300 }, ['postgres', 'redis']);

    expect(out).toEqual({ postgres: 5432, redis: 6379 });
  });

  it('falls back to the supplied map for a missing or out-of-range key', () => {
    const out = editablePortsFrom({ postgres: 99999 }, ['postgres', 'redis'], { postgres: 5432, redis: 6379 });

    expect(out).toEqual({ postgres: 5432, redis: 6379 });
  });

  it('omits a key with neither a usable value nor a fallback', () => {
    expect(editablePortsFrom({}, ['postgres'])).toEqual({});
  });
});

describe('servicePortRows — labels come from the catalog', () => {
  const byPath = catalogByPath(CATALOG);

  it('labels a row from the catalog entry and uses its description as the tooltip', () => {
    expect(servicePortRows(['postgres'], { postgres: 5432 }, false, byPath)).toEqual([
      {
        key: 'postgres',
        path: 'ports.postgres',
        group: 'Datastores',
        label: 'Postgres',
        value: 5432,
        info: 'Why this knob exists.',
      },
    ]);
  });

  it('omits a key the catalog does not describe rather than inventing a label for it', () => {
    expect(servicePortRows(['brandNewSink'], { brandNewSink: 4444 }, false, byPath)).toEqual([]);
  });

  it('marks the read-only rows and skips a key the eval did not report', () => {
    const rows = servicePortRows(['redis', 'grafana'], { redis: 6379 }, true, byPath);

    expect(rows).toEqual([
      {
        key: 'redis',
        path: 'ports.redis',
        group: 'Datastores',
        label: 'Redis',
        value: 6379,
        info: 'Why this knob exists.',
        readOnly: true,
      },
    ]);
  });
});

describe('readOnlyPortsFrom — every port Nix declares read-only, not a curated slice', () => {
  it('keeps every key the read-only group names', () => {
    const keys = ['grafana', 'otlpHttp', 'lokiHttp', 'hubApi'];

    const out = readOnlyPortsFrom({ grafana: 4300, otlpHttp: 4318, lokiHttp: 3100, hubApi: 3000 }, keys);

    expect(out).toEqual({ grafana: 4300, otlpHttp: 4318, lokiHttp: 3100, hubApi: 3000 });
  });

  it('reads a slot-derived port from its base, not from the enclosing object', () => {
    const out = readOnlyPortsFrom({ hubApi: { base: 3000 }, spoke: { base: 8000 }, grafana: 4300 }, [
      'hubApi',
      'spoke',
      'grafana',
    ]);

    expect(out).toEqual({ hubApi: 3000, spoke: 8000, grafana: 4300 });
  });

  it('omits a key the eval publishes no usable port for', () => {
    expect(readOnlyPortsFrom({ grafana: 4300, lokiHttp: 0 }, ['grafana', 'lokiHttp'])).toEqual({ grafana: 4300 });
  });
});

describe('readOnlyPortRows — a slot-derived port is catalogued under .base', () => {
  it('renders a row for a port whose catalog path carries the base suffix', () => {
    const catalog = new Map(
      [entry({ path: 'ports.hubApi.base', label: 'Hub API', group: 'Ports', kind: 'port', default: 3000 })].map((e) => [
        e.path,
        e,
      ]),
    );

    const rows = readOnlyPortRows(['hubApi'], { hubApi: 3000 }, catalog);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: 'hubApi', label: 'Hub API', value: 3000, readOnly: true });
  });

  it('renders one row per read-only key rather than dropping the unresolvable ones', () => {
    const catalog = new Map(
      [
        entry({ path: 'ports.grafana', label: 'Grafana', group: 'Ports', kind: 'port', default: 4300 }),
        entry({ path: 'ports.hubApi.base', label: 'Hub API', group: 'Ports', kind: 'port', default: 3000 }),
      ].map((e) => [e.path, e]),
    );

    const rows = readOnlyPortRows(['grafana', 'hubApi'], { grafana: 4300, hubApi: 3000 }, catalog);

    expect(rows.map((r) => r.key)).toEqual(['grafana', 'hubApi']);
  });
});
