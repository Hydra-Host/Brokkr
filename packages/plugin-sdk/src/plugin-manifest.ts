import type { Type } from '@nestjs/common';
import type { AppRouter } from '@ts-rest/core';
import type { z } from 'zod';

import type { BrokkrGateName } from './gates';

export interface PluginManifest<TConfigSchema extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined> {
  id: string;

  version: string;

  schemaName?: string;

  migrationsDir?: string;

  /** Lazy import, e.g. `() => import('./backend')` — a thunk so backend code never enters the apps/web bundle and gets its own chunk on the api side. */
  backendModule?: () => Promise<{ default: Type<unknown> } | Type<unknown>>;

  contract?: AppRouter;

  configSchema?: TConfigSchema;

  allowedGates?: readonly BrokkrGateName[];

  bridgeModule?: () => Promise<{ default: Type<unknown> } | Type<unknown>>;
}
