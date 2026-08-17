import type { z } from 'zod';

import type { PluginManifest } from './plugin-manifest';

export function definePlugin<TConfigSchema extends z.ZodTypeAny | undefined = undefined>(
  manifest: PluginManifest<TConfigSchema>,
): PluginManifest<TConfigSchema> {
  return manifest;
}
