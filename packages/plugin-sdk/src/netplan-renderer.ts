export const PLUGIN_NETPLAN_RENDERER = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_NETPLAN_RENDERER');

/** Mirrors api-client's `NetplanPhase`; kept local so the plugin SDK remains dependency-free. */
export type PluginNetplanPhase = 'live' | 'deploy';

export interface PluginRenderNetplanRequest {
  deviceId: string;
  phase: PluginNetplanPhase;
}

export interface PluginRenderNetplanResult {
  yaml: string;
}

/** Host-owned Netplan renderer. Operator plugins must authenticate callers before invoking it. */
export interface PluginNetplanRenderer {
  renderForDevice(input: PluginRenderNetplanRequest): Promise<PluginRenderNetplanResult>;
}
