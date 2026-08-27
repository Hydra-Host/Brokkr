import { buildPluginConfigProviders } from '@hydrahost/plugin-runtime';
import { API_PREFIX, getPluginConfigToken } from '@hydrahost/plugin-sdk';
import pluginsConfig from '@hydrahost/plugins-config';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { getPluginIdForPath, mergedContract } from '../merged-contract';

const NOMAD_CONFIG_TOKEN = getPluginConfigToken('nomad');

const NOMAD_ROUTE_KEYS = [
  'nomadHealth',
  'nomadValidate',
  'nomadPlan',
  'nomadSubmit',
  'nomadStatus',
] as const;

const NOMAD_PATHS = [
  `${API_PREFIX}/plugins/nomad/health`,
  `${API_PREFIX}/plugins/nomad/validate`,
  `${API_PREFIX}/plugins/nomad/plan`,
  `${API_PREFIX}/plugins/nomad/submit`,
  `${API_PREFIX}/plugins/nomad/status`,
] as const;

const NOMAD_SRC_PATTERN = /plugin-nomad|NomadClient|@hydrahost\/plugin-nomad|\/nomad\//;

function scanForNomadRefs(dir: string, hits: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__test__' && entry.name !== 'node_modules') {
        scanForNomadRefs(full, hits);
      }
    } else if (entry.name.endsWith('.ts')) {
      readFileSync(full, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (NOMAD_SRC_PATTERN.test(line)) {
            hits.push(`${full}:${i + 1}: ${line.trim()}`);
          }
        });
    }
  }
  return hits;
}

describe('nomad plugin fail-closed (enabled: false)', () => {
  it('stays disabled when NOMAD_PLUGIN_ENABLED is unset (CI assumption)', () => {
    expect(
      process.env.NOMAD_PLUGIN_ENABLED,
      'this suite requires NOMAD_PLUGIN_ENABLED unset so fail-closed assertions stay meaningful',
    ).not.toBe('true');
    const entry = pluginsConfig.find((e) => e.plugin.id === 'nomad');
    expect(entry).toBeDefined();
    expect(entry?.enabled).toBe(false);
  });

  it('omits every Nomad contract key from the host mergedContract', () => {
    for (const key of NOMAD_ROUTE_KEYS) {
      expect(mergedContract[key], `unexpected merged route key ${key}`).toBeUndefined();
    }
  });

  it('does not map Nomad paths to a plugin id (host returns Nest 404)', () => {
    for (const path of NOMAD_PATHS) {
      expect(getPluginIdForPath(path)).toBeUndefined();
    }
  });

  it('does not bind Nomad config providers when disabled', () => {
    expect(() => buildPluginConfigProviders(pluginsConfig)).not.toThrow();
    const providers = buildPluginConfigProviders(pluginsConfig);
    expect(providers.some((p) => 'provide' in p && p.provide === NOMAD_CONFIG_TOKEN)).toBe(false);
  });

  it('has no Nomad client imports under apps/api/src (excluding this regression suite)', () => {
    const apiSrc = join(__dirname, '../..');
    const hits = scanForNomadRefs(apiSrc);
    expect(hits, `unexpected Nomad references in apps/api/src:\n${hits.join('\n')}`).toEqual([]);
  });
});
