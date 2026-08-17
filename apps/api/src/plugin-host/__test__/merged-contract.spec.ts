import { validateAndMergePluginContracts } from '@hydrahost/plugin-runtime';
import { API_PREFIX, type PluginManifest } from '@hydrahost/plugin-sdk';
import pluginsConfig from '@hydrahost/plugins-config';
import { contract as coreContract } from '@repo/api-client';
import { isRecord } from '@repo/utils';
import type { AppRoute } from '@ts-rest/core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { generateApiDocument } from '../../common/openapi';
import type { PrismaClient } from '../../prisma/prisma.client';
import { getPluginIdForPath, mergedContract } from '../merged-contract';

const VALID_VISIBILITIES = new Set(['public', 'internal']);

function routeVisibility(route: AppRoute): unknown {
  const meta = route.metadata;
  return meta !== null && typeof meta === 'object' && 'visibility' in meta ? meta.visibility : undefined;
}

function isAppRoute(value: unknown): value is AppRoute {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    'path' in value &&
    typeof value.path === 'string'
  );
}

describe('mergedContract', () => {
  it('keeps core route paths unchanged and prefixed', () => {
    for (const [routeKey, candidate] of Object.entries(coreContract)) {
      if (!isAppRoute(candidate)) continue;
      const route = candidate;
      const mergedRoute = mergedContract[routeKey];
      if (!isAppRoute(mergedRoute)) {
        throw new Error(`Merged contract route "${routeKey}" is missing or invalid`);
      }
      expect(mergedRoute).toBeDefined();
      expect(mergedRoute.path).toBe(route.path);
      expect(mergedRoute.path.startsWith(API_PREFIX)).toBe(true);
    }
  });

  it('exposes the live plugin registry without dropping or duplicating routes', () => {
    const enabledManifests = pluginsConfig.filter((entry) => entry.enabled).map((entry) => entry.plugin);
    const expectedPluginKeys = enabledManifests.flatMap((manifest) =>
      Object.entries(manifest.contract ?? {})
        .filter(([, route]) => isAppRoute(route))
        .map(([key]) => key),
    );
    for (const key of expectedPluginKeys) {
      expect(isAppRoute(mergedContract[key]), `plugin route "${key}" missing from merged contract`).toBe(true);
    }
    for (const key of expectedPluginKeys) {
      expect(Object.prototype.hasOwnProperty.call(coreContract, key)).toBe(false);
    }
  });
});

describe('mergedContract composition (fixed fixture)', () => {
  const FIXTURE_PLUGIN_ID = 'acme';
  const LIST_PATH = `${API_PREFIX}/plugins/${FIXTURE_PLUGIN_ID}/widgets`;
  const GET_PATH = `${API_PREFIX}/plugins/${FIXTURE_PLUGIN_ID}/widgets/:id`;

  function makeRoute(path: string): AppRoute {
    return { method: 'GET', path, responses: { 200: z.object({ ok: z.boolean() }) } };
  }

  function makeManifest(id: string, contract: PluginManifest['contract']): PluginManifest {
    return { id, version: '0.0.0', contract };
  }

  const fixtureManifest = makeManifest(FIXTURE_PLUGIN_ID, {
    listWidgets: makeRoute(LIST_PATH),
    getWidget: makeRoute(GET_PATH),
  });

  function composeFixture(manifests: PluginManifest[]) {
    const pluginRoutes = validateAndMergePluginContracts(manifests, Object.keys(coreContract));
    const merged: Record<string, unknown> = { ...coreContract, ...pluginRoutes };
    const pluginIdByPath = new Map<string, string>();
    for (const manifest of manifests) {
      for (const route of Object.values(manifest.contract ?? {})) {
        if (typeof route === 'object' && route !== null && 'path' in route && typeof route.path === 'string') {
          pluginIdByPath.set(route.path, manifest.id);
        }
      }
    }
    return { merged, pluginIdByPath };
  }

  it('merges exactly the two fixture routes at their hand-authored paths', () => {
    const { merged } = composeFixture([fixtureManifest]);

    expect(isAppRoute(merged.listWidgets)).toBe(true);
    expect(isAppRoute(merged.getWidget)).toBe(true);
    expect((merged.listWidgets as AppRoute).path).toBe(LIST_PATH);
    expect((merged.getWidget as AppRoute).path).toBe(GET_PATH);

    const pluginKeyCount = ['listWidgets', 'getWidget'].filter((k) => isAppRoute(merged[k])).length;
    expect(pluginKeyCount).toBe(2);
  });

  it('preserves core routes intact through the spread', () => {
    const { merged } = composeFixture([fixtureManifest]);
    for (const [key, route] of Object.entries(coreContract)) {
      if (!isAppRoute(route)) continue;
      expect(merged[key]).toBe(route);
    }
  });

  it('rejects a plugin route key that collides with a core route key', () => {
    const [coreKey] = Object.keys(coreContract);
    expect(coreKey).toBeDefined();
    const collidingManifest = makeManifest(FIXTURE_PLUGIN_ID, {
      [coreKey]: makeRoute(LIST_PATH),
    });
    expect(() => composeFixture([collidingManifest])).toThrow(/conflicts with a core API route key/);
  });

  it('maps each fixture route path back to its owning plugin id', () => {
    const { pluginIdByPath } = composeFixture([fixtureManifest]);
    expect(pluginIdByPath.get(LIST_PATH)).toBe(FIXTURE_PLUGIN_ID);
    expect(pluginIdByPath.get(GET_PATH)).toBe(FIXTURE_PLUGIN_ID);
    expect(pluginIdByPath.get(`${API_PREFIX}/unknown`)).toBeUndefined();
  });

  it('getPluginIdForPath resolves the owning plugin id for live plugin routes and is undefined otherwise', () => {
    const [coreRoute] = Object.values(coreContract).filter(isAppRoute);
    if (coreRoute) expect(getPluginIdForPath(coreRoute.path)).toBeUndefined();
    expect(getPluginIdForPath(`${API_PREFIX}/definitely/not/a/plugin/route`)).toBeUndefined();

    const enabledManifests = pluginsConfig.filter((entry) => entry.enabled).map((entry) => entry.plugin);
    for (const manifest of enabledManifests) {
      for (const route of Object.values(manifest.contract ?? {})) {
        if (isAppRoute(route)) expect(getPluginIdForPath(route.path)).toBe(manifest.id);
      }
    }
  });
});

describe('route visibility metadata', () => {
  it('every core contract route declares an explicit, valid visibility', () => {
    for (const [routeKey, route] of Object.entries(coreContract)) {
      if (!isAppRoute(route)) continue;
      const visibility = routeVisibility(route);
      expect(VALID_VISIBILITIES.has(visibility as string), `route "${routeKey}" is missing metadata.visibility`).toBe(
        true,
      );
    }
  });
});

describe('generateApiDocument visibility filtering', () => {
  const ROTATE_PATH = `${API_PREFIX}/devices/me/live-token/rotate`;
  const CLOUD_INIT_PATH = `${API_PREFIX}/cloud-init-templates`;

  it('excludes the internal device-token rotate route from the public doc', async () => {
    const doc = await generateApiDocument(null, ['public']);
    const paths = Object.keys(doc.paths ?? {});
    expect(paths).not.toContain(ROTATE_PATH);
    expect(paths).toContain(CLOUD_INIT_PATH);
  });

  it('includes the device-token rotate route when the internal tier is requested', async () => {
    const doc = await generateApiDocument(null, ['internal']);
    expect(Object.keys(doc.paths ?? {})).toContain(ROTATE_PATH);
  });

  it('excludes every /admin path from the public doc', async () => {
    const doc = await generateApiDocument(null, ['public']);
    const adminPaths = Object.keys(doc.paths ?? {}).filter((p) => p.startsWith(`${API_PREFIX}/admin/`));
    expect(adminPaths).toEqual([]);
  });

  it('treats a route with no visibility metadata as non-public (fail closed)', async () => {
    const taglessPath = `${API_PREFIX}/__visibility_fail_closed_probe__`;
    const original = mergedContract.__visibilityFailClosedProbe;
    mergedContract.__visibilityFailClosedProbe = {
      method: 'GET',
      path: taglessPath,
      responses: { 200: z.object({}) },
    } as unknown as AppRoute;
    try {
      const doc = await generateApiDocument(null, ['public']);
      expect(Object.keys(doc.paths ?? {})).not.toContain(taglessPath);
    } finally {
      if (original === undefined) delete mergedContract.__visibilityFailClosedProbe;
      else mergedContract.__visibilityFailClosedProbe = original;
    }
  });
});

describe('generateApiDocument OS slug enum injection', () => {
  function collectEnums(node: unknown): unknown[][] {
    const result: unknown[][] = [];
    if (Array.isArray(node)) {
      for (const element of node) {
        result.push(...collectEnums(element));
      }
      return result;
    }
    if (!isRecord(node)) return result;
    if (Array.isArray(node.enum)) {
      result.push(node.enum);
    }
    for (const value of Object.values(node)) {
      result.push(...collectEnums(value));
    }
    return result;
  }

  function makeMockPrisma(layers: Array<{ slug: string; kind: string }>): PrismaClient {
    return {
      layer: {
        findMany: async ({ where }: { where: { kind: string } }) => {
          return layers
            .filter((l) => l.kind === where.kind)
            .map((l) => ({ slug: l.slug }))
            .sort((a, b) => a.slug.localeCompare(b.slug));
        },
      },
    } as unknown as PrismaClient;
  }

  it('injects only BASE layer slugs into the OS enum, filtering out LEGACY, LIVE, COMPONENT, and INTERNAL', async () => {
    const allLayers = [
      { slug: 'ubuntu-22.04', kind: 'BASE' },
      { slug: 'debian-12', kind: 'BASE' },
      { slug: 'centos-legacy', kind: 'LEGACY' },
      { slug: 'brokkr-live', kind: 'LIVE' },
      { slug: 'nvidia-driver', kind: 'COMPONENT' },
      { slug: 'internal-bootstrap', kind: 'INTERNAL' },
    ];
    const mockPrisma = makeMockPrisma(allLayers);
    const doc = await generateApiDocument(mockPrisma, ['public']);
    const allEnums = collectEnums(doc);

    const nonBaseSlugs = ['centos-legacy', 'brokkr-live', 'nvidia-driver', 'internal-bootstrap'];
    const flatEnums = allEnums.flat();
    for (const slug of nonBaseSlugs) {
      expect(flatEnums).not.toContain(slug);
    }

    const expectedSlugs = ['debian-12', 'ubuntu-22.04'];
    const matchingEnums = allEnums.filter(
      (e) => e.length === expectedSlugs.length && expectedSlugs.every((s) => e.includes(s)),
    );
    expect(matchingEnums.length).toBeGreaterThan(0);
  });

  it('skips enum injection when no layers are returned', async () => {
    const mockPrisma = makeMockPrisma([]);
    const doc = await generateApiDocument(mockPrisma, ['public']);
    const docWithoutPrisma = await generateApiDocument(null, ['public']);
    const enumsWithPrisma = collectEnums(doc);
    const enumsWithoutPrisma = collectEnums(docWithoutPrisma);
    expect(enumsWithPrisma.length).toBe(enumsWithoutPrisma.length);
  });
});
