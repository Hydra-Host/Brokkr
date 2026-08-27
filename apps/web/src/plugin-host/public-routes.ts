import type { PluginPublicRoute, PluginPublicRouteLayout } from '@hydrahost/plugin-sdk';

export interface PublicRouteRegistryEntry {
  pluginId: string;
  route: PluginPublicRoute;
}

export function normalizePublicPath(path: string): string {
  if (path === '') return '/';
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
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
