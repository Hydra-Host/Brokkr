import type { PluginPublicRoute, PluginPublicRouteLayout } from '@hydrahost/plugin-sdk';

export interface PublicRouteRegistryEntry {
  pluginId: string;
  route: PluginPublicRoute;
}

const PUBLIC_PLUGIN_HOST_ROUTE_ID = '/_navbar-layout/$';

export type CorePathMatcher = (path: string) => boolean;

interface PublicRouteValidationResult {
  invalidPluginIds: Set<string>;
  errors: string[];
}

export function normalizePublicPath(path: string): string {
  if (path === '') return '/';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

export function isCoreHostRoute(matches: readonly { routeId: string }[]): boolean {
  const leaf = matches.at(-1);
  return leaf !== undefined && leaf.routeId !== PUBLIC_PLUGIN_HOST_ROUTE_ID;
}

export function validatePublicPluginRoutes(
  routes: readonly PublicRouteRegistryEntry[],
  isCorePath: CorePathMatcher,
): PublicRouteValidationResult {
  const invalidPluginIds = new Set<string>();
  const errors: string[] = [];
  const owners = new Map<string, string[]>();

  for (const entry of routes) {
    const path = entry.route.path;
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
      invalidPluginIds.add(entry.pluginId);
      errors.push(
        `Public route "${path}" from plugin "${entry.pluginId}" must be an absolute path without query or hash`,
      );
      continue;
    }

    const normalized = normalizePublicPath(path);
    if (isCorePath(normalized)) {
      invalidPluginIds.add(entry.pluginId);
      errors.push(`Public route "${normalized}" from plugin "${entry.pluginId}" conflicts with a core host route`);
      continue;
    }
    owners.set(normalized, [...(owners.get(normalized) ?? []), entry.pluginId]);
  }

  for (const [path, routeOwners] of owners) {
    if (routeOwners.length < 2) continue;
    const uniqueOwners = [...new Set(routeOwners)];
    uniqueOwners.forEach((pluginId) => invalidPluginIds.add(pluginId));
    errors.push(
      uniqueOwners.length === 1
        ? `Public route "${path}" is declared more than once by plugin "${uniqueOwners[0]}"`
        : `Public route collision at "${path}" between plugins ${uniqueOwners.map((id) => `"${id}"`).join(', ')}`,
    );
  }

  return { invalidPluginIds, errors };
}

export function findPublicPluginRoute(
  routes: readonly PublicRouteRegistryEntry[],
  pathname: string,
  layout: PluginPublicRouteLayout,
): PublicRouteRegistryEntry | undefined {
  const normalized = normalizePublicPath(pathname);
  return routes.find((entry) => entry.route.layout === layout && normalizePublicPath(entry.route.path) === normalized);
}

export function pluginIdFromPluginsPath(pathname: string): string | undefined {
  if (!pathname.startsWith('/plugins/')) return undefined;
  const pluginId = pathname.slice('/plugins/'.length).split('/')[0];
  return pluginId === undefined || pluginId === '' ? undefined : pluginId;
}

function withSearch(path: string, searchStr: string): string {
  if (!searchStr || searchStr === '?') return path;
  return searchStr.startsWith('?') ? `${path}${searchStr}` : `${path}?${searchStr}`;
}

/** `/plugins/:id` under `_app` yields to a declared navbar `publicRoutes` path. */
export function publicRedirectFromPluginAppMount(
  pathname: string,
  searchStr: string,
  publicRoutes: readonly PublicRouteRegistryEntry[],
): string | undefined {
  const pluginId = pluginIdFromPluginsPath(pathname);
  if (!pluginId) return undefined;
  const path = publicRoutes.find((entry) => entry.pluginId === pluginId)?.route.path;
  if (!path) return undefined;
  return withSearch(path, searchStr);
}
