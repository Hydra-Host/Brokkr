import type { PluginFrontendManifest } from './plugin-frontend-manifest';

export interface FrontendPluginConfigEntry {
  plugin: PluginFrontendManifest;
}

export function defineFrontendPluginsConfig(entries: readonly []): FrontendPluginConfigEntry[];
export function defineFrontendPluginsConfig<const T extends readonly FrontendPluginConfigEntry[]>(entries: T): T;
export function defineFrontendPluginsConfig(
  entries: readonly FrontendPluginConfigEntry[],
): readonly FrontendPluginConfigEntry[] {
  return entries;
}
