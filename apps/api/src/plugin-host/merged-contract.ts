import { validateAndMergePluginContracts } from '@hydrahost/plugin-runtime';
import { contract as coreContract } from '@repo/api-client';
import { initContract, type AppRouter } from '@ts-rest/core';

import pluginsConfig from '@hydrahost/plugins-config';

const enabledPluginManifests = pluginsConfig.filter((entry) => entry.enabled).map((entry) => entry.plugin);

const pluginRoutes = validateAndMergePluginContracts(enabledPluginManifests, Object.keys(coreContract));

const pluginIdsByPath = new Map<string, string>();
for (const manifest of enabledPluginManifests) {
  if (!manifest.contract) continue;
  for (const route of Object.values(manifest.contract)) {
    if (typeof route === 'object' && route !== null && 'path' in route && typeof route.path === 'string') {
      pluginIdsByPath.set(route.path, manifest.id);
    }
  }
}

const c = initContract();
export const mergedContract: AppRouter = c.router(
  {
    ...coreContract,
    ...pluginRoutes,
  },
  { strictStatusCodes: true },
);

export function getPluginIdForPath(path: string): string | undefined {
  return pluginIdsByPath.get(path);
}
