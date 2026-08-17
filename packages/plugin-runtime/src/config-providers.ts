import { getPluginConfigToken, type PluginManifest } from '@hydrahost/plugin-sdk';
import type { Provider } from '@nestjs/common';
import { z } from 'zod';

interface ConfigProviderEntry {
  plugin: PluginManifest<z.ZodTypeAny | undefined>;
  enabled: boolean;
  settings?: unknown;
}

export function buildPluginConfigProviders(entries: readonly ConfigProviderEntry[]): Provider[] {
  const providers: Provider[] = [];
  for (const entry of entries) {
    if (!entry.enabled) continue;
    const schema = entry.plugin.configSchema;
    if (!schema) continue;

    const rawSettings = entry.settings ?? {};
    let parsed: unknown;
    try {
      parsed = schema.parse(rawSettings);
    } catch (err) {
      if (err instanceof z.ZodError) {
        const issues = err.issues
          .map((i) => `  • ${i.path.length > 0 ? i.path.join('.') : '(root)'}: ${i.message}`)
          .join('\n');
        throw new Error(`Plugin "${entry.plugin.id}" config validation failed:\n${issues}`);
      }
      throw err;
    }

    providers.push({
      provide: getPluginConfigToken(entry.plugin.id),
      useValue: parsed,
    });
  }
  return providers;
}
