/** Boot-time IDs of plugins the host enabled. Bound by the hub PluginHostModule; not a live registry. */
export const PLUGIN_ENABLED_IDS = Symbol.for('@hydrahost/plugin-sdk/PLUGIN_ENABLED_IDS');

export type PluginEnabledIds = ReadonlySet<string>;
