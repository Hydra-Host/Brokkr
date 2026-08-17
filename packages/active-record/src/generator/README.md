# Active-record generator

Scaffolds a `*.record.ts` (and a matching `*.record.spec.ts`) from a Prisma model. It reads the split schema files under `packages/database/prisma/models/`, derives a Zod persistence schema + record class + spec skeleton, and either previews to stdout or writes the files.

It's a **boilerplate accelerator**, not a finisher: it emits the imports, schema, input interfaces, finders, and CRUD that are mechanical to type. Anything the schema can't express (MTI upgrade transactions, relation-path tenancy, bespoke pagination) is emitted as a clearly-marked stub for you to complete.

---

## Quick start (interactive wizard)

From the repo root:

```bash
pnpm gen:record
```

With no `--model` on a terminal, this launches a guided wizard. It walks the schema and asks, in order:

1. **Model** — type an exact name or any substring; it filters the model list and lets you pick a number.
2. **Record name** — suggested from the model (`DcimRackRole` → `RackRole`); Enter to accept.
3. **Extension** — lists the model's to-one relations; type one (e.g. `pdu`) to fold it in, or blank for none.
4. **Discriminator** — free-text body (e.g. `role: DeviceRole.PDU`); hinted from a detected `role` enum column.
5. **Soft-delete** — auto-detects a `deletedAt` column and offers `Y/n`; otherwise asks for the column name.
6. **Tenant field** — shows detected candidates (`organizationId`, `supplierId`, …); blank = cross-tenant.
7. **Fields** — prints a numbered column list; accept names or numbers (`name,status,role` or `2,8,10`), blank = all.
8. **Output** — suggests an admin records path when the record looks admin-y; `-` for a stdout preview.

Before generating, it prints the **equivalent non-interactive command** (copy-paste it into scripts) and asks to proceed.

---

## Non-interactive usage

```bash
pnpm gen:record -- --model <PrismaModel> [options]
```

| Flag                     | Meaning                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `--model <Name>`         | Prisma model, PascalCase (e.g. `DcimRackRole`). **Required** in non-interactive mode. |
| `--name <RecordName>`    | Record class base name (default: model name). `RackRole` → `RackRoleRecord`.          |
| `--tenant-field <field>` | Tenant column (`organizationId`) or relation path (`circuit.organizationId`).         |
| `--soft-delete <field>`  | Soft-delete column (e.g. `deletedAt`).                                                |
| `--discriminator <body>` | Verbatim discriminator object body, e.g. `"role: DeviceRole.PDU"`.                    |
| `--fields <a,b,c>`       | Lean base-column allow-list (comma-separated). See [conditions](#--fields).           |
| `--extension <relation>` | Fold in a 1:1 MTI extension by its relation name. See [conditions](#--extension).     |
| `--out <file>`           | Write to `<file>` and a spec under `__test__/`. Without it, preview to stdout.        |
| `--no-spec`              | Skip the spec file.                                                                   |
| `--force`                | Overwrite existing files.                                                             |
| `--models-dir <dir>`     | Override the Prisma models directory.                                                 |
| `--list-models`          | Print available model names and exit.                                                 |
| `-h, --help`             | Show help.                                                                            |

Run `pnpm gen:record -- --help` for the same reference plus examples.

---

## What gets generated

For a model with no policy flags you get:

- a `<Name>PersistenceSchema` Zod object with every scalar/enum column,
- a record class `extends createActiveRecord(Schema, '<delegate>', <policy?>)` with `list`, `findByIdOrThrow`, `create`, `updateById`, and `deleteById`,
- a spec skeleton wired to `ActiveRecordRegistry.configureForTest(...)` with a sample row.

Mutation methods take their input type straight from the schema — `Partial<z.infer<typeof <Name>PersistenceSchema>>` — rather than hand-written `Create`/`Update` interfaces. (`Partial<>` is assignable to the `DeepPartial<Data>` the base `build()`/`set()` expect, and the nested extension key rides along automatically.) Records that drive mutations off contract request types just swap the param type when finishing the scaffold.

The policy object and several methods change based on the conditions below.

---

## Conditions (this is the important part)

### `--tenant-field`

- **Flat column** (`organizationId`): added to the policy as `tenantField: 'organizationId'` (the framework auto-fills it on `build()`), and the spec's `configureForTest` is given a stub `organizationId`.
- **Relation path** (`circuit.organizationId`): added to the policy, **but `create()` is emitted as a stub** + a warning. `build()` can't auto-fill a parent's tenant, so you must implement `create` explicitly (verify the parent is reachable from the caller's org, then persist). See `CircuitTerminationRecord.create`.

### `--soft-delete`

Added as `softDeleteField`. With it set, the framework's `record.delete()` soft-deletes and scoped reads default-filter the column. No effect on which methods are generated (other than `deleteById` semantics flipping to soft).

### `--discriminator`

Added verbatim as `discriminator: { <body> }`. The column referenced by the body is auto-retained even under a lean `--fields` selection (see below), because the policy is validated against the schema at class-load time — a discriminator column missing from the schema throws immediately.

### `--fields`

Restricts the **base** persistence schema / spec sample to the listed columns. Always-retained regardless of the list:

- `id` (the primary key),
- the **discriminator** column(s),
- the **soft-delete** column,
- the **flat tenant** column.

This guarantees the generated policy stays valid. Omit `--fields` to include every column. This flag is essential when generating against wide base tables like `Device` (80+ columns).

### `--extension` (multi-table inheritance)

Resolves the named relation on the base model to its 1:1 extension model and:

- nests the extension's columns under that key in the schema (the back-reference FK, e.g. `deviceId`, is dropped — it duplicates the base id),
- emits a standalone `<relation>AggregateInclude` const (`{ <relation>: true } satisfies Prisma.<Model>Include`) and references it from the policy as `include: <relation>AggregateInclude` — a single, type-checked expansion point for adding presenter selects (e.g. `zone`/`organization`),
- adds `extension: { relationName: '<relation>' }` to the policy (the schema declares the nested key so Zod won't strip the included relation),
- mutation params (`Partial<z.infer<…>>`) carry the nested extension key, so `set({ pdu: {...} })` stays typed,
- **emits `create()` as a stub and emits NO delete**, with a warning.

Why the stub: the admin MTI surfaces (Server/Switch/PDU/CDU/…) don't _create_ a fresh base row — they **upgrade** an existing `role = null` device to a role and attach its extension in one transaction, which doesn't map onto `build()`. Implement `create()` against `ActiveRecordRegistry.client` using `AdminSwitchRecord.create` as the reference. There is **no detach**: extensions are never stripped from a live base row — removal is a soft-delete of the base Device (which keeps the extension), so the MTI invariant (`role = X` iff its extension row exists) holds by construction.

> **Generate against the base model, not the extension.** For an admin PDU record you run `--model Device --extension pdu` (bound to the `device` delegate), _not_ `--model Pdu`. The discriminator (`role`) and soft-delete (`deletedAt`) columns live on `Device`; a record bound to `pdu` with those policy fields throws at class-load because they aren't `Pdu` columns.

---

## Output, preview, and the spec

- **No `--out`** → record (and spec, unless `--no-spec`) print to stdout. Safe to explore.
- **`--out <path>`** → writes `<path>` and, unless `--no-spec`, a spec at `<dir>/__test__/<kebab>.record.spec.ts`. Refuses to overwrite existing files unless `--force`.
- Warnings (relation-path / MTI stubs) print to **stderr** so they don't pollute a piped preview.

---

## After generating

1. **Finish any stubs** the warnings called out (`create` for relation-path tenants; `create` + detach/delete for `--extension`).
2. **Add the reads your surface needs** that base finders can't express — paginated lists, `count`/`aggregate`, bespoke includes — via the scoped `_delegate()` (tier 2). See the package [README](../../README.md) "Three tiers of data access".
3. **Type the data getter** if the record loads relations/aggregates (override `data` to the precise Prisma payload type — see `BaremetalRecord` / `InventoryRecord`).
4. **Fill in the spec** — the skeleton covers `findByIdOrThrow` and `list`; add coverage for the mutations.
5. No per-record module registration is needed; `ActiveRecordModule.forRoot()` is wired once per app.

---

## How it works (internals)

| File               | Responsibility                                                                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma-schema.ts` | Minimal reader of the split `*.prisma` files — classifies each field as scalar/enum/relation with flags. Not a full Prisma parser; runs before `prisma generate`. |
| `codegen.ts`       | Pure rendering. Maps Prisma scalars → Zod/TS, applies the conditions above, returns the `.record.ts` + `.record.spec.ts` strings + warnings. No I/O.              |
| `cli.ts`           | Arg parsing, the interactive wizard, `--list-models`, stdout-preview vs file-write, and warning output.                                                           |
