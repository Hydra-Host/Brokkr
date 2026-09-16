import {
  EXTENSION_SLOTS,
  type ExtensionSlot,
  type PluginFrontendModule,
  type PluginRoute,
  type SlotContributionMap,
} from '@hydrahost/plugin-sdk';
import frontendPluginsConfig from '@hydrahost/plugins-config/frontend';
import { createApiClient } from '@repo/api-client';

import { type CorePathMatcher, type PublicRouteRegistryEntry, validatePublicPluginRoutes } from './public-routes';

const api = createApiClient({ baseUrl: '' });

async function fetchEnabledPluginIds(): Promise<Set<string>> {
  const res = await api.getEnabledPlugins();
  if (res.status !== 200) {
    throw new Error(`[plugin-host] unexpected status ${res.status} from /plugins/enabled`);
  }
  return new Set(res.body.pluginIds);
}

async function fetchIsInstanceOperator(): Promise<boolean> {
  try {
    const res = await api.getPluginHostContext();
    return res.status === 200 ? res.body.isInstanceOperator : false;
  } catch {
    return false;
  }
}

export interface SlotRegistryEntry<S extends ExtensionSlot = ExtensionSlot> {
  pluginId: string;
  contribution: SlotContributionMap[S];
}

export interface RouteRegistryEntry {
  pluginId: string;
  route: PluginRoute;
}

export interface PluginRegistry {
  slots: Map<ExtensionSlot, SlotRegistryEntry[]>;
  routes: Map<string, RouteRegistryEntry>;
  publicRoutes: PublicRouteRegistryEntry[];
}

export const EMPTY_PLUGIN_REGISTRY: PluginRegistry = {
  slots: new Map(),
  routes: new Map(),
  publicRoutes: [],
};

export async function loadPluginRegistry(isCorePath: CorePathMatcher): Promise<PluginRegistry> {
  const slots: PluginRegistry['slots'] = new Map();
  const routes: PluginRegistry['routes'] = new Map();
  const publicRoutes: PublicRouteRegistryEntry[] = [];

  const [enabledPluginIds, isInstanceOperator] = await Promise.all([
    fetchEnabledPluginIds(),
    fetchIsInstanceOperator(),
  ]);

  for (const entry of frontendPluginsConfig) {
    if (!enabledPluginIds.has(entry.plugin.id)) continue;
    if (entry.plugin.operatorOnly && !isInstanceOperator) continue;
    try {
      const mod = await entry.plugin.frontend();
      const frontendModule: PluginFrontendModule = 'default' in mod ? mod.default : mod;

      if (frontendModule.slots) {
        for (const slot of EXTENSION_SLOTS) {
          const contributions = frontendModule.slots[slot];
          if (!contributions) continue;
          const list = slots.get(slot) ?? [];
          for (const contribution of contributions) {
            list.push({ pluginId: entry.plugin.id, contribution });
          }
          slots.set(slot, list);
        }
      }

      if ('publicRoutes' in frontendModule && frontendModule.publicRoutes) {
        for (const route of frontendModule.publicRoutes) {
          publicRoutes.push({ pluginId: entry.plugin.id, route });
        }
      } else if (frontendModule.rootRoute) {
        routes.set(entry.plugin.id, {
          pluginId: entry.plugin.id,
          route: frontendModule.rootRoute,
        });
      }
    } catch (err) {
      console.error(`[plugin-host] failed to load frontend for plugin "${entry.plugin.id}":`, err);
    }
  }

  const validation = validatePublicPluginRoutes(publicRoutes, isCorePath);
  for (const error of validation.errors) {
    console.error(`[plugin-host] ${error}; affected plugin disabled`);
  }
  if (validation.invalidPluginIds.size === 0) {
    return { slots, routes, publicRoutes };
  }

  for (const [slot, contributions] of slots) {
    const validContributions = contributions.filter(({ pluginId }) => !validation.invalidPluginIds.has(pluginId));
    if (validContributions.length === 0) {
      slots.delete(slot);
    } else {
      slots.set(slot, validContributions);
    }
  }
  for (const pluginId of validation.invalidPluginIds) {
    routes.delete(pluginId);
  }

  return {
    slots,
    routes,
    publicRoutes: publicRoutes.filter(({ pluginId }) => !validation.invalidPluginIds.has(pluginId)),
  };
}
