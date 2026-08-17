# @repo/active-record

A thin active-record layer over Prisma. Each record class binds a **Zod schema** to a **Prisma model** and gains a consistent set of finders, mutations, and persistence helpers — with **tenant isolation, soft-delete, role discrimination, and multi-table inheritance** built into the base class so individual records don't hand-roll them.

The goal is uniformity: every record reads, writes, scopes, and deletes the same way, and the cross-cutting safety rules (don't leak across tenants, don't return soft-deleted rows, don't load the wrong row type) are enforced by the framework instead of by discipline at each call site.

---

## Defining a record

```ts
import { createActiveRecord } from '@repo/active-record';
import { z } from 'zod';

const ZoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  organizationId: z.string(),
  deletedAt: z.date().nullable(),
});

export class ZoneRecord extends createActiveRecord(ZoneSchema, 'zone', {
  tenantField: 'organizationId',
  softDeleteField: 'deletedAt',
}) {
  // Business rules live here as instance methods:
  rename(name: string): this {
    return this.set({ name });
  }
}
```

`createActiveRecord(schema, modelName, policy?)` returns a base class you extend. The policy is validated **at class-creation time** (module load) — a `tenantField`/`discriminator`/`softDeleteField` that isn't a column on the schema, or an `extension` that doesn't match the schema shape, throws immediately rather than on the first query.

### Adding a record — the short version

> **Tip:** scaffold the boilerplate with the generator instead of hand-writing it — `pnpm gen:record` launches an interactive wizard. See [`src/generator/README.md`](src/generator/README.md) for the full walkthrough and conditional behaviors (tenant scoping, soft-delete, discriminators, MTI extensions, lean field selection).

1. Write a Zod schema with every column the record reads. `modelName` must match a `PrismaClient` model key (e.g. `'zone'`, `'device'`).
2. `extends createActiveRecord(Schema, modelName, policy)` and pick the policy fields you need (all optional): `tenantField`, `softDeleteField`, `discriminator`, `include`, `extension`.
3. Add **typed static wrapper methods** for the finders you expose (annotate their return types — see [Typing note](#typing-note)).
4. Put **business rules** on the record as instance methods that call `this.set(...)` and return `this`.
5. That's it — no module registration per record; `ActiveRecordModule.forRoot()` is wired once per app ([Setup](#setup-nestjs)).

---

## Constructing records

The constructor is `protected` — all construction goes through a named factory, which keeps construction sites grep-able and ensures schema parsing runs consistently.

| Factory                                                   | Use when                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `Record.build(data)`                                      | Creating a brand-new row (INSERT on `save()`). Auto-fills tenant + scalar discriminator columns. |
| `Record.fromRow(row)`                                     | You already have the row/aggregate in memory — wrap it without a DB query.                       |
| `Record.findById(id)`                                     | Look up by primary key, **auto-scoped** to the current tenant.                                   |
| `Record.findOne(args)` / `findMany(args)`                 | Scoped query / list.                                                                             |
| `Record.findByIdUnscoped(id)`                             | Cross-tenant by id (admin / saga / billing).                                                     |
| `Record.findOneUnscoped(args)` / `findManyUnscoped(args)` | Cross-tenant query / list.                                                                       |

Escape hatches for custom queries (includes, `count`/`aggregate`/`groupBy`):

- `Record._delegate()` — scoped Prisma delegate (auto-injects tenant/discriminator/soft-delete pins on reads).
- `Record._unscopedDelegate()` — raw delegate, tenant pin bypassed.

The `Unscoped` suffix makes every deliberate cross-tenant operation greppable in review. See [Three tiers of data access](#three-tiers-of-data-access) for when to use the finders vs. these delegates vs. the raw client.

---

## Three tiers of data access

Every query a record makes lands in one of three tiers. They trade off **safety and convenience** against **flexibility**: tier 1 does the most for you, tier 3 does the least. Reach for the highest tier that can express your query — dropping a tier should be a deliberate, reviewable choice, not the default.

| Tier                   | API                                                            | Pins applied                                     | Auto-include                             | Returns                     | Bound to                             |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------- | --------------------------- | ------------------------------------ |
| **1. Base finders**    | `findById` / `findOne` / `findMany` (+ `Unscoped` / `OrThrow`) | tenant + discriminator + soft-delete             | yes (`policy.include` + extension chain) | parsed **record instances** | the record's own model               |
| **2. Scoped delegate** | `_delegate()` / `_unscopedDelegate()`                          | tenant + discriminator + soft-delete (via proxy) | **no** — you compose `include` yourself  | raw **Prisma rows**         | the record's own model               |
| **3. Raw client**      | `ActiveRecordRegistry.client`                                  | **none**                                         | no                                       | raw rows / anything         | **any** model, raw SQL, transactions |

### Tier 1 — Base finders (default)

The public finder API. Returns fully-parsed record instances with the complete aggregate (`policy.include` + any extension chain) hydrated, and every read pin applied automatically. This is the right tool for ~90% of reads — loading an entity by id or a small filtered list to then read or mutate.

```ts
const device = await BaremetalRecord.findByIdOrThrow(id); // record, fully hydrated, tenant-safe
const live = await BaremetalRecord.findMany({ where: { status: 'ONLINE' } });
```

Use the `Unscoped` variants for deliberate cross-tenant reads (admin / saga / billing) and the `OrThrow` variants for the "load or 404" path.

### Tier 2 — Scoped delegate (`_delegate`)

The Prisma delegate for the record's **own model**, wrapped in a proxy that auto-injects the same tenant / discriminator / soft-delete pins on every read method (`findUnique`, `findFirst`, `findMany`, `count`, `aggregate`, `groupBy`). Returns raw Prisma rows, **not** record instances, and does **not** auto-include the aggregate — you compose whatever `include` / `select` you need.

> **Bulk writes are NOT pinned — the proxy refuses them.** Only reads are scoped. `updateMany`, `deleteMany`, `createMany`, and `upsert` never route through `save()`/`delete()`'s `_scopeWhere()`, so the proxy cannot pin them; calling any of them on `_delegate()` (or `_unscopedDelegate()`) throws. For a deliberate unscoped bulk write, drop to the tier-3 raw client (`ActiveRecordRegistry.client`) with an explicit WHERE.

Reach for this when a base finder can't express the shape but you still want pin safety on the record's model:

- pagination (`count` + `findMany` handed to a pagination helper),
- `count` / `aggregate` / `groupBy`,
- partial `select`s or a bespoke `include` that differs from `policy.include`.

```ts
// Pagination rides the proxy — supplier/role/soft-delete pins applied automatically,
// no manual where-clause re-implementation:
const result = await paginateQuery(this._delegate(), query, config);

// Opt out of the soft-delete pin only (tenant + discriminator still apply):
const withDeleted = this._delegate(undefined, { includeDeleted: true });
```

`_unscopedDelegate()` is the same proxy with the **tenant pin bypassed** (discriminator + soft-delete still apply) — for cross-tenant custom queries. Authorization is then the caller's responsibility.

> Skipping tier 2 is the most common smell: code that drops straight from base finders to the raw client and then **re-implements the pins by hand** (`where: { organizationId, role, deletedAt: null }`). If the query is on the record's own model, `_delegate()` already owns those pins — let it.

### Tier 3 — Raw client (`ActiveRecordRegistry.client`)

The bare global `PrismaClient`. No pins, no scoping, no record wrapping. This is the escape hatch — and a signal that the operation may not really belong to this record. Legitimate uses:

- **raw SQL** (`client.$queryRaw`) for aggregations a delegate can't express,
- **a different model** than the record is bound to (e.g. a `Device` record resolving a `Server.id`, or writing a `Job` row),
- **multi-model transactions** (`client.$transaction`).

```ts
// Raw SQL aggregation — no record shape, no delegate can express it:
const rows = await ActiveRecordRegistry.client.$queryRaw<{ id: string }[]>`...`;
```

When a tier-3 method is really another model's lifecycle (writing `Job` / `Zone` rows from a `Device` record), prefer moving it onto that model's record or a dedicated repository rather than co-locating it here.

### Decision guide

1. **Loading/saving this record's entity?** → **tier 1** base finders. Default choice; you get pins, the aggregate, and a typed record.
2. **Custom query on this record's model that tier 1 can't express (pagination, `count`/`aggregate`, partial select, bespoke include) but you still want pin safety?** → **tier 2** `_delegate()` / `_unscopedDelegate()`.
3. **Raw SQL, a different model, or a multi-model transaction?** → **tier 3** `ActiveRecordRegistry.client` — and consider whether it belongs on a different record/repository.

---

## Reading and mutating

```ts
// Create
const zone = ZoneRecord.build({ name: 'us-west' }); // organizationId auto-filled from ctx
await zone.save(); // INSERT; data re-parsed from the DB row

// Update
const existing = await ZoneRecord.findById(id); // null if not found / wrong tenant / soft-deleted
existing.set({ name: 'us-east' }); // tracks a change, mutates in place
existing.isDirty; // true
existing.changes.name; // { from: 'us-west', to: 'us-east' }
await existing.save(); // UPDATE of only the dirty fields

// Delete (soft if `softDeleteField` is set, else physical)
await existing.delete();
```

- `data` is a **live** reference typed `Readonly<Data>` (mutated in place by `set()` — use `record.isDirty` / `record.changes`, not reference equality, to detect changes).
- `save()` emits an INSERT for `new` records and a minimal UPDATE (only dirty fields) for persisted ones, then re-parses the DB row so server-bumped columns (`@updatedAt`, defaults, triggers) are reflected without a refetch.

### Typing note

The base static factories return `any` (`build`/`fromRow`) or `Promise<any>` (the async finders) — TypeScript's polymorphic-`this` can't express "return the subclass" through the protected constructor. Recover precise types the way the real records do: **annotate your subclass wrapper methods' return types**.

```ts
export class ZoneRecord extends createActiveRecord(ZoneSchema, 'zone', { tenantField: 'organizationId' }) {
  // Typed entry point — callers get ZoneRecord, not `any`:
  static async findByIdOrThrow(id: string): Promise<ZoneRecord> {
    const record = await this.findById(id);
    if (!record) throw new NotFoundException('Zone not found');
    return record;
  }
}
```

For records that load relations/aggregates, also override the `data` getter to the precise Prisma-derived aggregate type (see `InventoryRecord` / `BaremetalRecord` for the canonical pattern).

---

## What the policy gives you

### Tenant scoping (`tenantField`)

Auto-injects `where.<tenantField> = ctx.organizationId` on every scoped read, auto-fills it on `build()`, and threads it into save/delete WHERE clauses.

- **With a request context bound** the tenant value is a strict override — a stray `where: { organizationId: ... }` can't widen scope.
- **With no context** (background jobs, seed scripts) a scoped read with no explicit tenant **throws `TenantContextRequiredError`** — the framework refuses to silently widen to all tenants. Cross-tenant callers must opt out via the `*Unscoped` finders.

Supports a flat column (`'organizationId'`) or a relation path (`'zone.organizationId'`) for records scoped through a parent.

### Permission gating (`actions`)

Maps business methods to permission keys — `actions: { decommission: 'device:delete', rename: 'zone:update' }`. The proxy enforces the mapped key the instant a gated method runs, and `Record.requireAction('decommission')` is the static fail-fast primitive for gating ahead of expensive work. Enforcement is **fail-closed**:

- **Context holding the key** → allowed.
- **Context missing the key** → `ForbiddenException`.
- **No context** (a gated mutation reached headless) → throws **`PermissionContextRequiredError`**. A real request always carries context, so this only fires in background code that didn't opt into a system context.

Trusted headless code (jobs, sagas, seed scripts) that must run a gated mutation opts into a **system context** via `ContextService.runAsSystem(organizationId, fn)` — it bypasses the permission gate (a system actor, not a user) for the callback's duration. Tenant scoping still applies; cross-tenant work also uses the `*Unscoped` finders. The bypass is explicit and greppable — there is no silent "no context = allowed" path.

```ts
await contextService.runAsSystem(supplierId, async () => {
  const record = await BaremetalRecord.findByDeviceIdOrThrow(deviceId);
  record.decommission(); // gated device:delete — allowed under the system context
  await record.save();
});
```

### Soft delete (`softDeleteField`)

- Scoped reads default-filter `<field> = null`, so soft-deleted rows drop out. Opt back in per-call with `findX(args, { includeDeleted: true })`.
- Declaring this field is the **sole switch** for `record.delete()`: with it, `delete()` soft-deletes (stamps the column via a scoped UPDATE); without it, `delete()` physically removes the row. There's no per-call override — the delete mode is a property of the record type. (To purge a soft-deletable row, drop to `Record._unscopedDelegate().delete(...)`.)

### Role discrimination (`discriminator`)

For shared base tables holding many entity kinds (e.g. `Device` rows discriminated by `role`). Pins e.g. `{ role: 'Server' }` on every read, auto-fills it on `build()`, and appends it to single-row write WHERE clauses (closing a write-side TOCTOU window). Through the scoped reads and `save()`/`delete()` a record class can never accidentally load or write the wrong row type — bulk writes are the exception and are refused outright (see tier 2), not silently mis-scoped.

### Always-on relations (`include`)

A Prisma `include` shape auto-merged into every finder so the record always carries presenter-shaped data. (The schema must declare every included relation, or Zod strips it on parse.)

---

## Multi-table inheritance (`extension`)

When one conceptual entity spans tables linked 1:1 by FK (`Device → Server → MarketplaceServer`), declare the chain and the framework treats it as a single entity:

```ts
export class ServerRecord extends createActiveRecord(ServerSchema, 'device', {
  tenantField: 'supplierId',
  extension: { relationName: 'server' }, // chain deeper via extension.extension
}) {
  updateEcoMode(value: boolean): this {
    return this.set({ server: { ecoMode: value } }); // deep-merged, change-tracked
  }
}
```

- Every read auto-includes the full chain; `data`/`set()`/`changes` mirror the nested shape.
- `save()` emits one nested `create`/`update` so the base and every extension row commit as a single Prisma operation.
- Hard `delete()` removes the base row and relies on `onDelete: Cascade` FKs to reap the chain. Extension tables must declare the parent FK as `@id` with `onDelete: Cascade` and keep audit columns on the base.

---

## Where logic lives

- **Business rules** (status transitions, lock checks, soft-delete-with-guard) → **instance methods on the record**, shared by every caller.
- **Shared "load + validate" rules** used by multiple service methods → a service-level entry point that returns an **aggregate**; consumers then read it or wrap it with `fromRow()` to mutate. Prefer fetching aggregates (`aggregate → record` via `fromRow` is free; `record → aggregate` needs a re-query).
- **Caller-kind-specific behavior** (admin/saga/billing filters) → the consuming service, **not** the record. Keep `*ForAdmin`/`*ForSaga` methods off the record.

See `.agents/skills/active-record-pattern/SKILL.md` for the decision tree, heuristics, and migration checklist.

---

## Setup (NestJS)

Register the global module once, pointing it at your `PrismaClient` and (optionally) a request-context provider:

```ts
@Module({
  imports: [
    ActiveRecordModule.forRoot(PrismaClient, {
      // omit for apps that operate cross-tenant (e.g. admin)
      contextProvider: { useExisting: ActiveRecordContextProvider },
    }),
  ],
})
export class AppModule {}
```

The provider's `getContext()` returns the current request's `{ organizationId, permissions }`, a system context (`{ organizationId, system: true }`) inside a `runAsSystem` scope, or `undefined` for headless work. With no context, scoped reads and gated mutations **fail closed** (see [Permission gating](#permission-gating-actions)) rather than silently widen. Under the hood this configures `ActiveRecordRegistry` — the static holder that records read the Prisma client and caller identity from — so records need no constructor injection.

---

## Errors

- `TenantContextRequiredError` — a scoped operation ran with no context and no explicit tenant. Caught by a global exception filter (clients see a generic 500; logs/Sentry get `model` + `tenantField`).
- `PermissionContextRequiredError` — a policy-gated mutation ran with no context bound (neither a user identity nor a `runAsSystem` system context). Fails closed; carries the required `permission` key. Like the tenant error, it signals a missing-context bug in headless code, not a user's 403.
- `RecordNotFoundError` — a save/delete matched no row (Prisma `P2025`), typically a TOCTOU or cross-tenant write attempt.

---

## Testing

`ActiveRecordRegistry.configureForTest(delegates, contextProvider?)` installs a partial Prisma mock and an optional context function, so suites can exercise finders/mutations without a database. See `src/__test__/` for the patterns.
