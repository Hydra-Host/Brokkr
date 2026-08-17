export function getPluginConfigToken(pluginId: string): symbol {
  return Symbol.for(`@hydrahost/plugin-config/${pluginId}`);
}
