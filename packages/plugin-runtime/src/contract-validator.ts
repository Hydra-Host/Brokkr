import { API_PREFIX, type PluginManifest } from '@hydrahost/plugin-sdk';
import type { AppRoute, AppRouter } from '@ts-rest/core';

interface ValidatedPluginRoute {
  pluginId: string;
  routeKey: string;
  route: AppRoute;
}

export function validateAndMergePluginContracts(
  manifests: readonly PluginManifest[],
  coreRouteKeys: readonly string[] = [],
): Record<string, AppRoute> {
  const seenKeys = new Map<string, string>();
  const coreKeySet = new Set(coreRouteKeys);
  const merged: Record<string, AppRoute> = {};

  for (const { pluginId, routeKey, route } of iteratePluginRoutes(manifests)) {
    const expectedPrefix = `${API_PREFIX}/plugins/${pluginId}/`;
    if (!route.path.startsWith(expectedPrefix)) {
      throw new Error(
        `Plugin "${pluginId}" contract route "${routeKey}" has path "${route.path}". ` +
          `Plugin route paths must start with "${expectedPrefix}" — compose your fragment with ` +
          `c.router(routes, { pathPrefix: API_PREFIX }) and use relative paths like ` +
          `"/plugins/${pluginId}/things".`,
      );
    }

    if (coreKeySet.has(routeKey)) {
      throw new Error(
        `Plugin route key collision: "${routeKey}" declared by plugin "${pluginId}" ` +
          `conflicts with a core API route key. Plugin route keys must be unique across ` +
          `core + plugins — prefix with the plugin id (e.g. "${pluginId}${capitalize(routeKey)}").`,
      );
    }

    const existingOwner = seenKeys.get(routeKey);
    if (existingOwner) {
      throw new Error(
        `Plugin route key collision: "${routeKey}" is declared by both ` +
          `"${existingOwner}" and "${pluginId}". Route keys must be unique across all enabled plugins — ` +
          `prefix your route keys with the plugin id (e.g. "${pluginId}${capitalize(routeKey)}").`,
      );
    }
    seenKeys.set(routeKey, pluginId);
    merged[routeKey] = route;
  }

  return merged;
}

function* iteratePluginRoutes(manifests: readonly PluginManifest[]): Generator<ValidatedPluginRoute> {
  for (const manifest of manifests) {
    const fragment = manifest.contract;
    if (!fragment) continue;
    for (const [routeKey, route] of Object.entries(fragment)) {
      if (!isAppRoute(route)) continue;
      yield { pluginId: manifest.id, routeKey, route };
    }
  }
}

function isAppRoute(candidate: AppRouter[string]): candidate is AppRoute {
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    'method' in candidate &&
    'path' in candidate &&
    typeof (candidate as { path?: unknown }).path === 'string'
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
