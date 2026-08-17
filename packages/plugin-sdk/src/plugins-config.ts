import type { z } from 'zod';

import type { PluginManifest } from './plugin-manifest';

type EntryFor<P extends PluginManifest<z.ZodTypeAny | undefined>> =
  P extends PluginManifest<infer S>
    ? [S] extends [z.ZodTypeAny]
      ? { plugin: P; enabled: boolean; settings: z.input<S> }
      : { plugin: P; enabled: boolean }
    : never;

export type PluginConfigEntry<M extends PluginManifest<z.ZodTypeAny | undefined> = PluginManifest> = EntryFor<M>;

export function definePluginsConfig(entries: readonly []): PluginConfigEntry[];
export function definePluginsConfig<
  const T extends ReadonlyArray<{ plugin: PluginManifest<z.ZodTypeAny | undefined> }>,
>(entries: T & { [K in keyof T]: EntryFor<T[K]['plugin']> }): T;
export function definePluginsConfig(
  entries: ReadonlyArray<{ plugin: PluginManifest<z.ZodTypeAny | undefined> }>,
): ReadonlyArray<unknown> {
  return entries;
}
