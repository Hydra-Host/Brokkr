export interface ActiveBridgePlugin {
  id: string;
  version: string;
}

interface RosterEntry {
  plugin: { id: string; version: string; bridgeModule?: unknown };
  enabled: boolean;
}

export function activePluginRoster(entries: readonly RosterEntry[]): ActiveBridgePlugin[] {
  return entries
    .filter((entry) => entry.enabled && entry.plugin.bridgeModule !== undefined)
    .map((entry) => ({ id: entry.plugin.id, version: entry.plugin.version }));
}

let snapshot: ActiveBridgePlugin[] = [];

export function setActiveBridgePlugins(plugins: ActiveBridgePlugin[]): void {
  snapshot = plugins;
}

export function getActiveBridgePlugins(): ActiveBridgePlugin[] {
  return snapshot;
}

export function resetActiveBridgePluginsForTests(): void {
  snapshot = [];
}
