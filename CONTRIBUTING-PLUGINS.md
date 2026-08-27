# Authoring Brokkr Plugins

This guide is for developers who want to extend a self-hosted Brokkr installation by publishing an npm package. If you just want to install someone else's plugin, jump to [Installing a plugin](#installing-a-plugin).

> **Status:** The plugin system is at v0.6. Stable across seven layers: data (per-plugin Postgres schemas + boot-time migrations, or fully stateless), backend (lazy-loaded NestJS module), HTTP contracts (ts-rest + OpenAPI), configuration (Zod-validated typed settings), frontend (per-slot-typed contributions, plugin root routes with sub-paths, typed ts-rest client), the typed plugin **event bus** (`PLUGIN_EVENT_BUS` — fire-and-forget event coordination between core and plugins, backed by `BrokkrEventMap` extensible type registry), and the per-request **identity context** (`PLUGIN_REQUEST_CONTEXT` — typed access to `userId`, `email`, `organizationId`, `role`, `authType`, plus `requirePermission(resource, action)` / `requireSessionAuth()` guards). The `pnpm plugins:uninstall` CLI is implemented; broader plugin-auth surface (declarative `requiresRole` route metadata, `@Public()` SDK re-export) remains on the roadmap.

## What is a plugin

A Brokkr plugin is a single npm package that contributes any combination of:

- A **Postgres schema** owned by the plugin (tables, indexes, functions)
- One or more **SQL migrations** applied at host boot
- A **NestJS module** that adds controllers, services, queue consumers, etc.
- A **ts-rest contract** declaring HTTP endpoints
- A **Zod `configSchema`** so the host validates and injects typed settings
- **React components** that contribute to named slots in the host UI
- A **typed ts-rest client** (`initClient(contractFragment, ...)`) that wraps the plugin's own contract for end-to-end type-safe calls from the plugin's UI

A plugin runs in the same process as the host, with full access to NestJS DI and Postgres. **Treat installing a plugin as equivalent to running someone else's code with your database credentials.** See [Trust](#trust) below.

## Architecture in one paragraph

Each plugin ships **two manifests** — a backend manifest (`plugin.ts`, the package's default export) and a frontend manifest (`plugin-frontend.ts`, exposed via the `./frontend-manifest` subpath). They never reference each other. apps/api imports only the backend manifest; apps/web imports only the frontend manifest. That isolation is what keeps apps/web's bundle free of NestJS and what makes the OSS install flow work. Both manifests are typically passed the same `contractFragment` and share a small `pluginManifest` constant for `id` / `version` — beyond that, they're fully independent.

## Package contract

Plugin authors install **`@hydrahost/plugin-sdk`** and depend on `@nestjs/common`, `@ts-rest/core`, `@ts-rest/nest`, `zod`, and (if shipping UI) `react` as peers. They do **not** depend on `@hydrahost/plugin-runtime` — that package is host-internal.

### `package.json`

```json
{
  "name": "@your-scope/brokkr-plugin-foo",
  "version": "0.1.0",
  "main": "./dist/plugin.js",
  "types": "./plugin.ts",
  "exports": {
    ".": { "types": "./plugin.ts", "require": "./dist/plugin.js", "import": "./dist/plugin.js" },
    "./frontend-manifest": {
      "types": "./plugin-frontend.ts",
      "require": "./dist/plugin-frontend.js",
      "import": "./dist/plugin-frontend.js"
    },
    "./backend": {
      "types": "./backend/index.ts",
      "require": "./dist/backend/index.js",
      "import": "./dist/backend/index.js"
    },
    "./contract": { "types": "./contract.ts", "require": "./dist/contract.js", "import": "./dist/contract.js" },
    "./frontend": {
      "types": "./frontend/index.ts",
      "require": "./dist/frontend/index.js",
      "import": "./dist/frontend/index.js"
    }
  },
  "files": ["dist", "database", "plugin.ts", "plugin-frontend.ts", "contract.ts", "schemas.ts", "backend", "frontend"],
  "scripts": { "build": "tsc" },
  "dependencies": {
    "@hydrahost/plugin-sdk": "^0.1.0",
    "zod": "^3.25.0"
  },
  "peerDependencies": {
    "@nestjs/common": ">=11",
    "@ts-rest/core": ">=3.51",
    "@ts-rest/nest": ">=3.51",
    "react": ">=19"
  }
}
```

Plugins must compile to `dist/`. The host loads them via `exports.require` pointing at compiled CJS; source `.ts` loading via Node's `--experimental-strip-types` does **not** work for workspace plugins.

Ship the `database/migrations/` directory in the published tarball (it's loaded at runtime, not compiled).

### Filesystem layout

```
your-plugin/
├── package.json
├── tsconfig.json                         # extends nestjs.json + jsx:react-jsx + DOM lib
├── plugin.ts                             # backend manifest, default export
├── plugin-frontend.ts                    # frontend manifest, ./frontend-manifest subpath
├── contract.ts                           # ts-rest fragment (shared by both manifests)
├── schemas.ts                            # Zod schemas (configSchema, response shapes, types)
├── backend/                              # NestJS module
│   ├── index.ts                          # exports the module class + default
│   ├── foo.module.ts
│   ├── foo.controller.ts
│   └── foo.service.ts
├── frontend/                             # React components
│   ├── index.ts                          # exports PluginFrontendModule (slot contributions)
│   └── foo-widget.tsx
├── database/
│   └── migrations/
│       ├── 0001_create_things.sql
│       └── 0002_add_index.sql
└── dist/                                 # built; published to npm
```

## The two manifests

### Backend manifest — `plugin.ts`

```typescript
import { join } from 'path';
import { definePlugin } from '@hydrahost/plugin-sdk';

import { contractFragment } from './contract';
import { FooConfigSchema } from './schemas';

export const fooManifest = definePlugin({
  id: 'foo', // stable lowercase identifier
  version: '0.1.0',
  schemaName: 'plugin_foo', // Postgres schema namespace
  migrationsDir: join(__dirname, '..', 'database', 'migrations'),
  backendModule: () => import('./backend'), // lazy thunk — see below
  contract: contractFragment,
  configSchema: FooConfigSchema,
});

export default fooManifest;
```

**`backendModule` must be a lazy thunk.** A static reference (`backendModule: FooModule`) would pull the entire NestJS chain into apps/web's bundle via the manifest's import graph. The `() => import('./backend')` form keeps the backend module dynamically imported on the api side and entirely absent from the frontend bundle.

**Named export AND default export.** Self-hosters' `plugins-config` package imports the manifest as a named import (`import { fooManifest as foo }`) to sidestep ESM-to-CJS default-import quirks. Always export your manifest by name first, then `export default`.

**`schemaName` + `migrationsDir` are optional.** Plugins that don't own Brokkr-side state — typically thin integration adapters where a third-party service is the source of truth (e.g. `@hydrahost/plugin-helpdesk-pylon`) — omit both fields. The host's migrator skips the plugin entirely; no Postgres schema is created. Add them later if you ever need to store local state.

### Frontend manifest — `plugin-frontend.ts`

```typescript
import { defineFrontendPlugin } from '@hydrahost/plugin-sdk';

import { contractFragment } from './contract';

export const fooFrontendManifest = defineFrontendPlugin({
  id: 'foo', // same id as backend manifest
  version: '0.1.0',
  frontend: () => import('./frontend'), // lazy thunk
  contract: contractFragment, // SAME reference the backend manifest uses
});

export default fooFrontendManifest;
```

The frontend manifest references **only** ts-rest contracts (pure types + Zod) and React component thunks. Never NestJS, never Prisma, never anything Node-only. This file is what apps/web walks; keeping it small keeps the frontend bundle clean.

Use the **same `contractFragment` reference** in both manifests. Backend handler binding and frontend type-safe client calls then can't disagree — they're literally the same object.

## SQL migrations

Plain numbered SQL files. Filename pattern: `^(\d+)_([a-zA-Z0-9_-]+)\.sql$` — for example `0001_create_things.sql`. Use zero-padded prefixes so lexicographic sort matches numeric order.

```sql
-- 0001_create_things.sql
CREATE TABLE plugin_foo.things (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id   UUID NOT NULL REFERENCES public.devices(id) ON DELETE CASCADE,
  payload     JSONB NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX things_device_id_idx ON plugin_foo.things(device_id);
```

Rules:

- Always qualify your tables with the schema name. The host creates the schema before running your migrations.
- Cross-schema foreign keys into `public.*` are fine. Plugins can FK into core tables; core never FKs into plugin tables.
- **Never edit a migration after it has been applied.** The runner verifies a sha256 checksum on every boot. A mismatch is a fatal error. To change schema, add a new `NNNN_*.sql`.
- Each `.sql` file runs in its own transaction.
- Multi-statement files are fine (separate with `;`).

**Migrations are forward-only.** There is no host-mediated rollback: the runner only ever applies forward migrations. `.down.sql` files are not a supported convention — ship only `NNNN_name.sql` files (any other name, including `.down.sql`, is rejected as an invalid filename at boot). To reverse schema, add a new forward migration. To remove a plugin's data entirely, drop its schema manually (see "Disabling and uninstalling" below).

## ts-rest contract

Plugin endpoints are first-class ts-rest routes. Use the same patterns as core, compose with `API_PREFIX` so paths match what NestJS registers:

```typescript
// contract.ts
import { API_PREFIX } from '@hydrahost/plugin-sdk';
import { initContract } from '@ts-rest/core';
import { ThingsListResponseSchema } from './schemas';

const c = initContract();

export const contractFragment = c.router(
  {
    fooListThings: {
      method: 'GET',
      path: '/plugins/foo/things', // must start with /plugins/{id}/
      responses: { 200: ThingsListResponseSchema },
      summary: 'List foo things',
      description: '…',
      metadata: { visibility: 'public' as const }, // public/internal/admin
    },
  },
  { pathPrefix: API_PREFIX }, // applies /api/v1
);
```

Path rules:

- Every route path must start with `/plugins/{your-plugin-id}/` (after `API_PREFIX` is applied). The host validates this at boot and fails fast on violations.
- Route **keys** must be unique across all enabled plugins. Convention: prefix keys with your plugin id (`fooListThings`, not `listThings`) so two community plugins can't collide.

## Backend module

Plugins are normal NestJS modules. The backend's `index.ts` exports BOTH a named class and a default for the lazy thunk to find:

```typescript
// backend/index.ts
import { FooModule } from './foo.module';

export { FooModule };
export default FooModule;
```

Inject the host's database client via `PLUGIN_PRISMA_CLIENT` and bind handlers to your contract via `@TsRestHandler`:

```typescript
// backend/foo.controller.ts
import { Controller } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';

import { contractFragment } from '../contract';
import { FooService } from './foo.service';

@Controller()
export class FooController {
  constructor(private readonly service: FooService) {}

  @TsRestHandler(contractFragment.fooListThings)
  listThings() {
    return tsRestHandler(contractFragment.fooListThings, async () => ({
      status: 200,
      body: await this.service.listThings(),
    }));
  }
}
```

```typescript
// backend/foo.service.ts
import { Inject, Injectable } from '@nestjs/common';
import { getPluginConfigToken, PLUGIN_PRISMA_CLIENT, PluginDb } from '@hydrahost/plugin-sdk';

import { FooConfig, ThingsListResponseSchema } from '../schemas';

const FOO_CONFIG_TOKEN = getPluginConfigToken('foo');

@Injectable()
export class FooService {
  constructor(
    @Inject(PLUGIN_PRISMA_CLIENT) private readonly db: PluginDb,
    @Inject(FOO_CONFIG_TOKEN) private readonly config: FooConfig,
  ) {}

  async listThings() {
    const rows = await this.db.$queryRawUnsafe<unknown>('SELECT * FROM plugin_foo.things ORDER BY recorded_at DESC');
    return ThingsListResponseSchema.parse(rows);
  }
}
```

`PluginDb` is a structural interface exposing `$queryRawUnsafe` and `$executeRawUnsafe`. The host's Prisma client satisfies it. If you need richer Prisma typings, declare `@prisma/client` as a peer dependency and type your injected client as `PrismaClient` directly — the host's instance is structurally compatible.

**Always validate raw query results with Zod before returning them.**

## Configuration

Plugins that need runtime settings (API keys, webhook URLs, thresholds) declare a Zod schema on the manifest. The host parses settings at boot and injects the parsed value into the plugin's NestJS services.

```typescript
// schemas.ts
import { z } from 'zod';

export const FooConfigSchema = z.object({
  webhookUrl: z.string().min(1).describe('Where to send alerts.'),
  threshold: z.number().int().positive().default(80),
});

export type FooConfig = z.infer<typeof FooConfigSchema>;
```

Self-hoster supplies settings in the **backend** plugins-config (`packages/plugins-config/src/index.ts`). The `settings` block is type-checked against your `configSchema` at the call site — wrong field name or wrong type is a compile error there, not a runtime surprise at boot.

### Rules

- **Secrets always come from environment variables.** Use `process.env.FOO_KEY ?? ''` in the config plus `.min(1)` in the schema to fail-fast if the env var is missing.
- **Use `.default(...)` liberally** so a plugin can be installed with `settings: {}` and still boot.
- **No computed values in the schema.** `configSchema` is for user-supplied settings, not for derived state.
- **Validation failures abort the host boot** with a formatted error listing each Zod issue.

## The typed event bus

Use the event bus when your plugin needs to react to things happening in core (org created, member added, device failed, zone alerting) — without core having to import your plugin. Events are **fire-and-forget**: emitters don't see handler results, handlers don't block emitters.

Subscribe in `OnModuleInit`, unsubscribe in `OnModuleDestroy`. The bus injects via the `PLUGIN_EVENT_BUS` token and is typed against the extensible `BrokkrEventMap` interface.

```typescript
import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy, Logger } from '@nestjs/common';
import { type BrokkrEventMap, PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';

// Side-effect import: augments BrokkrEventMap locally — see below.
import './brokkr-events.types';

@Injectable()
export class FooEventSubscribers implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FooEventSubscribers.name);
  private readonly unsubscribers: Array<() => void> = [];

  constructor(@Inject(PLUGIN_EVENT_BUS) private readonly eventBus: PluginEventBus) {}

  onModuleInit(): void {
    this.unsubscribers.push(
      this.eventBus.on('organization.created', (e) => this.handleOrgCreated(e)),
      this.eventBus.on('device.failed', (e) => this.handleDeviceFailed(e)),
    );
  }

  onModuleDestroy(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
  }

  private async handleOrgCreated(event: BrokkrEventMap['organization.created']): Promise<void> {
    this.logger.log(`org "${event.id}" created — syncing external system`);
    // ... your side effect here
  }

  private async handleDeviceFailed(event: BrokkrEventMap['device.failed']): Promise<void> {
    // Throw freely — the host's bus wraps handlers in try/catch.
    // Async rejections are logged with the event name.
  }
}
```

### Declaring the events you consume

`BrokkrEventMap` lives in `@hydrahost/plugin-sdk` as an empty interface. Core declares the event types it emits via a TypeScript module augmentation in apps/api. **Plugins build in isolation** — apps/api's augmentation isn't visible at your plugin's `tsc` time — so plugins **mirror the event shapes they handle** in their own augmentation file:

```typescript
// backend/brokkr-events.types.ts
import type { OrganizationMembershipRole, TenantType } from '@hydrahost/plugin-sdk';

declare module '@hydrahost/plugin-sdk' {
  interface BrokkrEventMap {
    'organization.created': { id: string; name: string; tenantType: TenantType };
    'member.added': {
      organizationId: string;
      userId: string;
      email: string;
      firstName: string;
      lastName: string;
      role: OrganizationMembershipRole;
    };
    // ... only the events this plugin actually handles
  }
}

export {};
```

Then `import './brokkr-events.types';` in your subscriber file for the side effect.

**Type-drift risk.** Your mirror is a copy of apps/api's declaration. If core changes a payload shape, your mirror goes stale and you'll see TS errors at the next build, or runtime exceptions when the handler reads a renamed field. Pin your plugin's host-version compatibility in the README and revalidate after every Brokkr upgrade. A future SDK release will host the canonical `BrokkrEventMap` so this mirror can go away.

**Error isolation.** The host's `HostPluginEventBus` wraps every handler with try/catch and logs unhandled rejections — one handler's failure cannot affect siblings or fail the emitting service. You still don't get a return channel; handlers are observers, not interceptors.

**v1 in-process limitation.** Today the bus is in-process (`@nestjs/event-emitter`). If admin and main apps run as separate processes, events emitted in one don't reach the other. Plugins load in the main app, so admin-emitted events currently won't trigger your handler. A future switch to Redis pub/sub would close this without changing the SDK surface.

## Request context

Use `PLUGIN_REQUEST_CONTEXT` when your plugin needs the authenticated caller's identity — typically inside HTTP handlers. Populated by the host's `UnifiedIdentityGuard`; accessors throw `UnauthorizedException` outside a request lifecycle (cron jobs, queue workers).

```typescript
import { Controller, Inject } from '@nestjs/common';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { PLUGIN_REQUEST_CONTEXT, type PluginRequestContext } from '@hydrahost/plugin-sdk';

import { contractFragment } from '../contract';
import { FooService } from './foo.service';

@Controller()
export class FooController {
  constructor(
    private readonly service: FooService,
    @Inject(PLUGIN_REQUEST_CONTEXT) private readonly ctx: PluginRequestContext,
  ) {}

  @TsRestHandler(contractFragment.fooDoThing)
  doThing() {
    return tsRestHandler(contractFragment.fooDoThing, async () => {
      this.ctx.requirePermission('deployment', 'create'); // 403s unless the caller holds it
      // this.ctx.requireSessionAuth();                          // rejects API-key callers
      return { status: 200, body: await this.service.doThing(this.ctx.userId) };
    });
  }
}
```

Available fields: `userId`, `email`, `firstName`, `lastName`, `organizationId`, `role` (`OrganizationMembershipRole`), `authType` (`'session' | 'api-key'`).

`requirePermission(resource, action)` throws `ForbiddenException` unless the caller holds that `resource:action` permission. `requireSessionAuth()` rejects API-key callers — use it for operations that should never run from automation (MFA setup, password change, etc.). `requireInstanceOperator()` accepts only the designated instance-operator org.

**Operator plugin endpoints** use `PluginOperatorGuard` from `@hydrahost/plugin-sdk/nest`. It calls host-backed `ctx.requireOperator({ adminOrganizationId })`:

- Instance operators always pass.
- When `PLUGIN_OPERATOR_ADMIN_ORG` is provided with a non-empty string that matches the caller's `organizationId`, that org also passes (managed-edition admin panel). Empty string does not grant access.
- Omit the token for instance-operator only (this is `operator-hub`).
- Missing request identity fails closed.

```typescript
import { getPluginConfigToken } from '@hydrahost/plugin-sdk';
import { PLUGIN_OPERATOR_ADMIN_ORG, PluginOperatorGuard } from '@hydrahost/plugin-sdk/nest';

// PluginOperatorGuard must be a provider: an unresolvable controller-scoped guard is silently skipped (gate bypass), not a boot error.
@Module({
  controllers: [OperatorFooController],
  providers: [
    PluginOperatorGuard,
    {
      provide: PLUGIN_OPERATOR_ADMIN_ORG,
      useFactory: (config: FooConfig) => config.adminOrganizationId,
      inject: [getPluginConfigToken('foo')],
    },
  ],
})
export class FooModule {}
```

**Authentication is automatic.** `UnifiedIdentityGuard` is registered as an `APP_GUARD` in the host. Every plugin route runs through it before reaching your handler. The context is populated by the time your handler executes, or `UnauthorizedException` was already thrown — you never see unauthenticated calls.

**Public routes are the rare exception.** Import `PublicRoute` from `@hydrahost/plugin-sdk/nest` to opt out of host authentication. Reserve it for routes serving anonymous visitors that touch no tenant data, and never read `PLUGIN_REQUEST_CONTEXT` from them — its accessors throw without an identity.

Anonymous write endpoints must also use `PluginRateLimit` from `@hydrahost/plugin-sdk/nest`. Add `PluginRateLimitGuard` to the plugin module's providers, then declare a plugin-local policy:

```typescript
@PublicRoute()
@PluginRateLimit({ name: 'lead-submission', limit: 10, windowSeconds: 60 })
```

The host consumes the fixed window atomically in namespaced Redis, so limits hold across replicas and restarts. Requests without a resolved client IP fail closed with `429`.

**Don't reach for the host's `ContextService` directly.** Plugins distributed via npm have no path access to `apps/api/src/common/context/context.service`. The SDK token is the supported abstraction.

## Frontend slots

Plugins extend the host UI at **named extension slots**. Each slot type has its own contribution shape, declared in the SDK's `SlotContributionMap`. Some slots take a full React component (host renders it directly); others take plain data (host renders its own primitives using the data). The slot's shape is enforced at the type level — wrong-shape contributions are a compile error at the plugin's `slots` literal, never a runtime surprise.

Available slot names live in `EXTENSION_SLOTS`. Currently shipped:

| Slot                    | Shape                                               | Host renders                                               | Use for                                                      |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------ |
| `dashboard-widget`      | `{ component, label? }`                             | the plugin's component                                     | dashboard cards, custom widgets, freeform plugin UI          |
| `sidebar-nav`           | `{ label, to, icon?, section?, external?, popup? }` | the host's typed `<Link>` (or `<a>` if `external`/`popup`) | nav entries that link to plugin routes or off-platform URLs  |
| `address-autocomplete`  | `{ component }`                                     | the plugin's component above the address inputs            | geocoder search affordances that fill the host address forms |
| `inventory-page-extras` | `{ component }`                                     | the plugin's component after the listing grid              | lead-capture walls, banners, trackers on inventory pages     |
| `inventory-item-cta`    | `{ component }`                                     | the plugin's component in each listing-card footer         | secondary calls-to-action pre-filled with the card's specs   |

```tsx
// frontend/index.ts
import { defineFrontendModule } from '@hydrahost/plugin-sdk';

import { FooWidget } from './foo-widget';
import { HelloWorldPage } from './hello-world-page';

export default defineFrontendModule({
  slots: {
    'dashboard-widget': [{ component: FooWidget, label: 'Foo' }],
    'sidebar-nav': [{ label: 'Foo', to: '/plugins/foo' }],
  },
  rootRoute: {
    component: HelloWorldPage,
    label: 'Foo',
    description: 'Foo plugin overview and about page',
  },
});
```

**`dashboard-widget`** — your component is rendered inside a `PluginErrorBoundary` so a broken plugin can't crash the host. It receives `pluginId` and owns its entire rendering.

**`sidebar-nav`** — you contribute **data, not a component**. The host renders its own typed `<Link>` using your `label`/`to`/`icon`. This way plugins don't need to import `@tanstack/react-router` (or any other context-bearing library) to drop a link in the nav, and SPA navigation works because the Link comes from the host's bundle. The host auto-highlights the entry when the current URL starts with your `to` path, so sub-routes keep the entry active. The optional `icon` is a tiny React component receiving `{ className }` from the host — typically an inline SVG or a one-character glyph to avoid icon-library peer deps.

Optional fields:

- `section?: string` — group this entry under a collapsible heading bearing this name (matches the visual style of the host's platform-nav sections). Multiple plugins targeting the same `section` are co-located under one heading.
- `external?: boolean` — render as `<a target="_blank" rel="noopener noreferrer">` instead of an SPA `<Link>`. The host skips active-state highlighting (the URL never matches an in-app route). Use for off-platform destinations like external portals or vendor dashboards.
- `popup?: boolean` — the host opens `to` in a popup window and never re-navigates a window that is still open, so the document's state is preserved across clicks. Use for same-origin documents that need their own top-level browsing context — e.g. the webvm-terminal plugin's terminal page. Takes precedence over `external`.

**`address-autocomplete`** — your component renders a search affordance above the host's address inputs and reports picks via the `onResolved(address)` callback prop; the host writes the resolved parts into its own form, so the plugin never imports a form library. May fire more than once per pick (address parts first, timezone later).

**`inventory-page-extras`** — rendered once per inventory listing page (public and authenticated), after the listing grid. The host passes `{ category?, userEmail?, hasListings, isAuthenticated }` so contributions can adapt to the page: lead walls only for anonymous visitors, banners only when listings exist, trackers only on public pages.

**`inventory-item-cta`** — rendered inside each inventory listing card's footer, below the primary action. The host passes `{ category?, userEmail?, device }` where `device` carries the card's hardware summary (GPU/CPU/memory/storage) for pre-filling forms.

## Plugin routes

Plugins that need standalone pages contribute a `rootRoute`. The host renders it at `/plugins/<plugin-id>` (the bare URL) AND `/plugins/<plugin-id>/<anything>` (any sub-path). The plugin owns its entire URL namespace.

```tsx
// frontend/foo-page.tsx
import type { PluginRouteProps } from '@hydrahost/plugin-sdk';

export function FooPage({ pluginId, splat }: PluginRouteProps) {
  // splat = '' at the bare URL
  // splat = 'about' at /plugins/foo/about
  // splat = 'detail/123' at /plugins/foo/detail/123

  if (splat === '') return <Overview />;
  if (splat === 'about') return <About />;
  return <NotFoundInsidePlugin splat={splat} />;
}
```

The plugin parses the `splat` itself. Switch on the first segment, run a routing library internally, or use it as a state key — host doesn't care. Adding new sub-views in a plugin is a plugin-side change only, no host modifications needed.

Discovery and access:

- The host's **`/plugins` index** lists every plugin with a `rootRoute`, using the `label` and `description` you provide.
- If your plugin also contributes a `sidebar-nav` entry, users can navigate from anywhere in the host.
- Direct URL access works too — anyone can paste `/plugins/foo/about` into the address bar.

The plugin component is rendered inside a `PluginErrorBoundary` so plugin render errors don't crash the host.

### Internal navigation

For internal navigation between sub-views, **plugins should use plain `<a>` anchors or programmatic navigation**, not TanStack Router's `<Link>`. The plugin chunk and the host's main bundle resolve `@tanstack/react-router` to different module instances at runtime — the plugin's `<Link>` ends up looking for a router context that lives in a different module-scope than the host's `RouterProvider`. Symptoms include "no router found", "warning is not a function", and similar context-not-found errors.

Plain anchors trigger full page reloads on click, but the host re-mounts cleanly and the splat-based dispatch picks the new view. This is the same trade-off WordPress/Discourse plugins accept.

For sidebar nav specifically, the SDK's per-slot context handles this automatically — your `sidebar-nav` contribution is data, the host's renderer provides the typed Link with SPA navigation, and you don't have to think about module duplication at all. Future slot types where Link-style navigation matters will follow the same pattern.

## Plugin's typed ts-rest client

Build a typed ts-rest client from your own contract and use it with plain React state. This is deliberately the simplest pattern — no React Query coupling, no provider context required beyond what every React app has.

```tsx
// frontend/foo-widget.tsx
import { useEffect, useState } from 'react';
import { initClient } from '@ts-rest/core';

import { contractFragment } from '../contract';

const client = initClient(contractFragment, { baseUrl: '', baseHeaders: {} });

type Thing = { id?: string; name?: string };

export function FooWidget({ pluginId }: { pluginId: string }) {
  const [things, setThings] = useState<Thing[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    client
      .fooListThings()
      .then((res) => {
        if (cancelled) return;
        if (res.status === 200) setThings(res.body);
        else setError(`HTTP ${res.status}`);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // …render things, error, loading state…
}
```

The returned `data` from `client.<route>()` is a discriminated union `{ status: 200; body: ... } | { status: 4xx | 5xx; body: ... }` derived from your contract's `responses` map. Status-narrow with `if (res.status === 200)` and the body type is precise — same type safety React Query's `useQuery` would give, with none of the context coupling.

### Why not `initTsrReactQuery` / React Query?

The first version of this guide recommended `initTsrReactQuery(contractFragment, ...).fooListThings.useQuery({...})`. It looked elegant but is fragile across hosts:

- `tsr.useQuery` reads from a **tsr-instance-specific** React context that's provided by `tsr.ReactQueryProvider`. The host can't wrap every plugin contribution in every plugin's own provider, so this context is typically missing in plugin components.
- React Query's `useQueryClient` also has to find a `QueryClientProvider` in scope. That works in principle, but only if the host's `@tanstack/react-query` module instance is the **same** instance the plugin's chunk bundled. Plugin chunks loaded via dynamic import often get their own copy unless the host's Vite config has `manualChunks` configured to share React Query — which plugin authors can't control.

Plain `initClient + useEffect` works regardless of host module-bundling, doesn't require host-side `dedupe`/`manualChunks` configuration, and adds no peer-dep surface for plugin authors. Plugins that genuinely need React Query caching can opt in **if** they're willing to require that the host configures shared chunks for it — but that's an advanced opt-in, not the default.

## Installing a plugin

Self-hosters install plugins by editing the host repository's **shared plugins-config workspace package**:

```bash
# 1. Add the package to the plugins-config workspace
pnpm --filter @hydrahost/plugins-config add @your-scope/brokkr-plugin-foo

# 2. Register it in BOTH config files:

# packages/plugins-config/src/index.ts (backend side, used by apps/api):
#   import { fooManifest as foo } from '@your-scope/brokkr-plugin-foo';
#   export default definePluginsConfig([
#     ...,
#     { plugin: foo, enabled: true, settings: { webhookUrl: process.env.FOO_WEBHOOK_URL ?? '' } },
#   ]);

# packages/plugins-config/src/frontend.ts (frontend side, used by apps/web):
#   import { fooFrontendManifest as foo } from '@your-scope/brokkr-plugin-foo/frontend-manifest';
#   export default defineFrontendPluginsConfig([
#     ...,
#     { plugin: foo, enabled: true },
#   ]);

# 3. Rebuild + restart
pnpm --filter @hydrahost/plugins-config build
pnpm --filter api build
pnpm dev:main
```

**Why two config files?** They import from different subpaths of the plugin package (`<plugin>` for backend, `<plugin>/frontend-manifest` for frontend). That subpath separation is what keeps apps/web's bundle free of NestJS code. The duplication is mild — both files end up with similar one-line additions per plugin.

**Why named imports?** `import { fooManifest as foo }` avoids ESM-to-CJS default-import quirks where Node's interop returns the whole module namespace instead of the unwrapped default. Always import the manifest by its named export.

Disabling without removing data: flip `enabled: false` in both config files. The plugin's Postgres schema and rows are preserved; re-enabling resumes migrations from the last applied row.

Uninstalling: remove the entries from both config files, then drop the schema with `DROP SCHEMA <name> CASCADE` and clear the rows from `_brokkr_plugin_migrations` for that plugin id. A `pnpm plugins:uninstall <id>` CLI is planned.

## Trust

There is no sandbox. A plugin's code:

- Can query any data in your database (including other plugins' schemas and `public`)
- Can read any environment variable, including secrets
- Can make outbound network requests
- Runs with the same privileges as the host process

This is the same trust model as a Rails engine, a WordPress plugin, or a Vite plugin. Mitigations:

- Audit plugin source before installing
- Pin specific versions in `package.json` — never use `^` for untrusted plugins
- For sensitive deployments, maintain a private fork of any third-party plugin
- Prefer plugins you can read end-to-end in an evening over ones you can't

If you publish a plugin, document what data it reads, what it writes, and what network destinations it contacts.

## API versioning

`@hydrahost/plugin-sdk` follows semver. The fields and patterns documented above are stable within the `0.x` line.

Until the SDK reaches `1.0.0`, treat the API as evolving:

- Adding optional manifest fields is non-breaking
- Removing or repurposing fields is breaking and happens in a `0.x+1.0` jump
- The runtime (`@hydrahost/plugin-runtime`) is host-internal; its API may change without notice

Once `1.0` ships, plugins should pin the SDK with a caret (`"@hydrahost/plugin-sdk": "^1.0.0"`).

## Worked example

The reference plugin is `@hydrahost/plugin-hello-world` at `packages/plugins/hello-world/` in this repo. Read it end-to-end (~200 lines of code across the two manifests, contract, schemas, backend, and frontend) to see the full pattern. It intentionally exercises every layer: schema + migration, contract + handler, configSchema + typed settings, slot contributions (dashboard widget + sidebar nav), root route with sub-path dispatch, and typed ts-rest client.

## Module-duplication caveat for plugin UI

Anything that depends on React **context** (a router, a query client, a state library) is fragile across the plugin/host boundary because the plugin's chunk and the host's main bundle can resolve the library to different module instances at runtime, even with `dedupe` and `optimizeDeps` config. Symptoms include "no router found", "No QueryClient set", "warning is not a function", and similar context-not-found errors.

**Plugin authors: stay context-free.** Use plain `<a>` for internal navigation. Use `useState + useEffect + initClient` for data fetching (no React Query). Don't import `@tanstack/react-router`, `@tanstack/react-query`, `react-redux`, Zustand, or any other context-bearing library in plugin code.

**SDK-typed slots that need context** (e.g. `sidebar-nav`) are designed as data contributions — the plugin contributes plain values, the host renders the actual component using its own context-bound primitives. Use those slot types instead of trying to render context-dependent components yourself.

**If you absolutely need a context library** in a plugin widget, document it: state which library, which version, and that the host's Vite config must include it in both `resolve.dedupe` and `optimizeDeps.include`. Expect host installers to push back; it's a real operational burden.

## Publishing checklist

Before `npm publish`:

- [ ] `package.json` `files` array includes `dist`, `database`, both manifest sources, contract/schemas, and `backend`/`frontend` directories
- [ ] Both manifests use named exports first, then `export default` (so consumers can `import { ... as ... }`)
- [ ] `peerDependencies` declared for `@nestjs/common`, `@ts-rest/core`, `@ts-rest/nest` (backend), `react` (if shipping UI). Do NOT add `@tanstack/react-query`, `@tanstack/react-router`, or `@ts-rest/react-query` unless your widget actually opts in to them (and you've documented the host-side dedupe requirement).
- [ ] `@hydrahost/plugin-sdk` pinned with a caret (`^0.1.0`)
- [ ] `backendModule` is a lazy thunk (`() => import('./backend')`), not a static class reference
- [ ] All ts-rest route paths start with `/plugins/{id}/`
- [ ] All ts-rest route keys prefixed with the plugin id
- [ ] `sidebar-nav` entries' `to` paths point at routes that exist (typically `/plugins/{id}` or a sub-path)
- [ ] `rootRoute` component handles its `splat` prop (at minimum, render the empty-splat case)
- [ ] `dist/` builds clean with `tsc` (no `dist/` committed to git, but it must be in the published tarball — `npm pack --dry-run` to inspect)
- [ ] At least one migration tested end-to-end against a real Postgres
- [ ] README documents what the plugin reads, writes, and contacts
