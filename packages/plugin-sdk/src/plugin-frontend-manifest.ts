import type { AppRouter } from '@ts-rest/core';

import type { PluginFrontendModule } from './slots';

export interface PluginFrontendManifest {
  id: string;
  version: string;
  /** UI-only gate: apps/web skips the plugin for non-operators. The backend must still gate via `PluginOperatorGuard` / `ctx.requireOperator()`. */
  operatorOnly?: boolean;
  frontend: () => Promise<{ default: PluginFrontendModule } | PluginFrontendModule>;
  contract?: AppRouter;
}
