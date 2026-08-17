import type { ExtensionSlot, PluginFrontendModule, PluginRoute, SlotContributionMap } from '@hydrahost/plugin-sdk';
import frontendPluginsConfig from '@hydrahost/plugins-config/frontend';
import { createApiClient } from '@repo/api-client';

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
}

export interface PluginRegistry {
  slots: Map<ExtensionSlot, SlotRegistryEntry[]>;
  routes: Map<string, RouteRegistryEntry>;
}

export async function loadPluginRegistry(): Promise<PluginRegistry> {
  const slots: PluginRegistry['slots'] = new Map();
  const routes: PluginRegistry['routes'] = new Map();

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
        for (const [slotName, contributions] of Object.entries(frontendModule.slots)) {
          if (!contributions) continue;
          const slot = slotName as ExtensionSlot;
          const list = slots.get(slot) ?? [];
          for (const contribution of contributions) {
            list.push({ pluginId: entry.plugin.id, contribution });
          }
          slots.set(slot, list);
        }
      }

      if (frontendModule.rootRoute) {
        routes.set(entry.plugin.id, {
          pluginId: entry.plugin.id,
          route: frontendModule.rootRoute,
        });
      }
    } catch (err) {
      console.error(`[plugin-host] failed to load frontend for plugin "${entry.plugin.id}":`, err);
    }
  }

  return { slots, routes };
}
