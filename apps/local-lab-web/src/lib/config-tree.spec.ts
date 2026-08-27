import { describe, expect, it } from 'vitest';

import type { ConfigTreeEntry } from '@/contract';

import { configSource, filterConfigEntries, groupConfigEntries, isOverridden, matchesConfigQuery } from './config-tree';

function entry(over: Partial<ConfigTreeEntry> = {}): ConfigTreeEntry {
  const base: ConfigTreeEntry = {
    path: 'stackDefaults.hub.LOG_LEVEL',
    label: 'Log level',
    group: 'Logging',
    description: 'Pino level the hub logs at',
    value: 'debug',
    default: 'debug',
    definedIn: ['devenv/modules/hub.nix'],
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
}

describe('isOverridden', () => {
  it('is true when the effective value left the default', () => {
    expect(isOverridden(entry({ value: 'warn' }))).toBe(true);
  });

  it('takes the answer from the server for a secret, which the masked values cannot give', () => {
    expect(isOverridden(entry({ secret: true, value: '***', default: '***', overridden: true }))).toBe(true);
    expect(isOverridden(entry({ secret: true, value: '***', default: '***', overridden: false }))).toBe(false);
  });

  it('does not count an undeterminable row as overridden', () => {
    expect(isOverridden(entry({ secret: true, value: '***', default: '***', overridden: null }))).toBe(false);
  });
});

describe('configSource', () => {
  it('names the pinning variable ahead of any file', () => {
    const source = configSource(entry({ pinnedBy: 'BROKKR_LOG_LEVEL', definedIn: ['devenv/stack.local.nix'] }));

    expect(source).toMatchObject({ kind: 'pin', label: '$BROKKR_LOG_LEVEL' });
  });

  it('reads the overlay file that won over the module that declared it', () => {
    const source = configSource(entry({ definedIn: ['devenv/modules/hub.nix', 'devenv/stack.local.nix'] }));

    expect(source).toMatchObject({ kind: 'file', label: 'stack.local.nix' });
  });

  it('picks the last overlay file when several define the path', () => {
    const source = configSource(entry({ definedIn: ['devenv/stack.local.nix', 'devenv.local.nix'] }));

    expect(source.label).toBe('devenv.local.nix');
  });

  it('reads .env as an overlay file too', () => {
    expect(configSource(entry({ definedIn: ['.env'] })).label).toBe('.env');
  });

  it('reads a module-only definition as the default', () => {
    const source = configSource(entry({ definedIn: ['devenv/modules/hub.nix'] }));

    expect(source).toMatchObject({ kind: 'default', label: 'default', title: 'devenv/modules/hub.nix' });
  });

  it('keeps every definition site in the tooltip', () => {
    const source = configSource(entry({ definedIn: ['devenv/modules/hub.nix', 'devenv/stack.local.nix'] }));

    expect(source.title).toBe('devenv/modules/hub.nix → devenv/stack.local.nix');
  });
});

describe('matchesConfigQuery', () => {
  it('matches on the path', () => {
    expect(matchesConfigQuery(entry(), 'log_')).toBe(true);
  });

  it('matches on the value', () => {
    expect(matchesConfigQuery(entry({ value: 'trace' }), 'trac')).toBe(true);
  });

  it('ignores surrounding whitespace and case', () => {
    expect(matchesConfigQuery(entry(), '  HUB.log  ')).toBe(true);
  });

  it('rejects a substring that spans neither field', () => {
    expect(matchesConfigQuery(entry(), 'postgres')).toBe(false);
  });
});

describe('filterConfigEntries', () => {
  const entries = [entry({ path: 'hub.LOG_LEVEL', value: 'warn' }), entry({ path: 'ports.postgres', value: 'debug' })];

  it('keeps only the overridden rows by default', () => {
    expect(filterConfigEntries(entries, { query: '', showAll: false }).map((e) => e.path)).toEqual(['hub.LOG_LEVEL']);
  });

  it('keeps every row under show-all', () => {
    expect(filterConfigEntries(entries, { query: '', showAll: true })).toHaveLength(2);
  });

  it('applies the query on top of show-all', () => {
    expect(filterConfigEntries(entries, { query: 'ports', showAll: true }).map((e) => e.path)).toEqual([
      'ports.postgres',
    ]);
  });

  it('never lets the query resurrect a row the overridden filter dropped', () => {
    expect(filterConfigEntries(entries, { query: 'ports', showAll: false })).toEqual([]);
  });
});

describe('groupConfigEntries', () => {
  it('buckets by group in first-seen order', () => {
    const grouped = groupConfigEntries([
      entry({ path: 'a', group: 'Logging' }),
      entry({ path: 'b', group: 'Datastores' }),
      entry({ path: 'c', group: 'Logging' }),
    ]);

    expect(grouped.map((g) => g.group)).toEqual(['Logging', 'Datastores']);
    expect(grouped[0].entries.map((e) => e.path)).toEqual(['a', 'c']);
  });
});
