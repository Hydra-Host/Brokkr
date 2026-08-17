import { API_PREFIX, type PluginManifest } from '@hydrahost/plugin-sdk';
import type { AppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { validateAndMergePluginContracts } from '../contract-validator';

function makeRoute(path: string): AppRoute {
  return {
    method: 'GET',
    path,
    responses: {
      200: z.object({ ok: z.boolean() }),
    },
  };
}

function prefixedPath(pluginId: string, suffix: string): string {
  return `${API_PREFIX}/plugins/${pluginId}/${suffix}`;
}

function makeManifest(id: string, contract: PluginManifest['contract']): PluginManifest {
  return { id, version: '0.0.0', contract };
}

describe('validateAndMergePluginContracts', () => {
  it('throws when a plugin route path lacks the expected API-prefixed plugin prefix', () => {
    const manifest = makeManifest('acme', {
      listThings: makeRoute('/plugins/acme/things'),
    });

    expect(() => validateAndMergePluginContracts([manifest])).toThrow(`${API_PREFIX}/plugins/acme/`);
  });

  it('throws when a plugin route key collides with a core route key', () => {
    const manifest = makeManifest('acme', {
      getMe: makeRoute(prefixedPath('acme', 'me')),
    });

    expect(() => validateAndMergePluginContracts([manifest], ['getMe'])).toThrow(/conflicts with a core API route key/);
  });

  it('throws when two plugins declare the same route key', () => {
    const first = makeManifest('acme', {
      listThings: makeRoute(prefixedPath('acme', 'things')),
    });
    const second = makeManifest('beta', {
      listThings: makeRoute(prefixedPath('beta', 'things')),
    });

    expect(() => validateAndMergePluginContracts([first, second])).toThrow(/declared by both/);
  });

  it('merges a well-formed plugin contract fragment into the returned record', () => {
    const route = makeRoute(prefixedPath('acme', 'things'));
    const manifest = makeManifest('acme', { listThings: route });

    const merged = validateAndMergePluginContracts([manifest], ['getMe']);

    expect(Object.keys(merged)).toEqual(['listThings']);
    expect(merged.listThings).toBe(route);
  });

  it('silently skips contract entries that are not AppRoutes', () => {
    const route = makeRoute(prefixedPath('acme', 'things'));
    const manifest = makeManifest('acme', {
      listThings: route,
      nested: { getNested: makeRoute(prefixedPath('acme', 'nested')) },
    });

    const merged = validateAndMergePluginContracts([manifest]);

    expect(Object.keys(merged)).toEqual(['listThings']);
    expect(merged.nested).toBeUndefined();
  });

  it('skips a manifest that ships without a contract', () => {
    const merged = validateAndMergePluginContracts([makeManifest('acme', undefined)]);

    expect(merged).toEqual({});
  });
});
