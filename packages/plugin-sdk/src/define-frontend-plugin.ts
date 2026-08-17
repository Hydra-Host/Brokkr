import type { PluginFrontendManifest } from './plugin-frontend-manifest';

/** The manifest must live in its own file so the `./frontend-manifest` subpath never statically references backend code. */
export function defineFrontendPlugin(manifest: PluginFrontendManifest): PluginFrontendManifest {
  return manifest;
}
