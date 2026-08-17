import { Prisma } from '@repo/database';

export interface SaveOptions {
  tx?: Prisma.TransactionClient;
}

export interface LeafChange<V> {
  from: V;
  to: V;
}

/** Narrow with `isLeafChange` (structural `'from' in entry` is unsafe); tuple wrapping suppresses TypeScript's distributive conditional on `boolean`. */
export type ChangeEntry<V> = [V] extends [Date | RegExp | bigint | Uint8Array | ReadonlyArray<unknown>]
  ? LeafChange<V>
  : [V] extends [object]
    ? LeafChange<V> | ChangeSet<V>
    : LeafChange<V>;

export type ChangeSet<T> = {
  [K in keyof T]?: ChangeEntry<T[K]>;
};

export type RecordState = 'new' | 'persisted' | 'deleted';

export class RecordNotFoundError extends Error {
  constructor(
    public readonly model: string,
    public readonly recordId: string,
  ) {
    super(`${model} record not found (id: ${recordId})`);
    this.name = 'RecordNotFoundError';
  }
}

export class TenantContextRequiredError extends Error {
  constructor(
    public readonly model: string,
    public readonly tenantField: string,
  ) {
    super('Tenant context required for scoped operation');
    this.name = 'TenantContextRequiredError';
  }
}

export class PermissionContextRequiredError extends Error {
  constructor(public readonly permission: string) {
    super(`Permission context required: gated action "${permission}" cannot run without a request context`);
    this.name = 'PermissionContextRequiredError';
  }
}

export interface RecordPolicy<TFields extends string = string> {
  /** Column auto-scoped to `ctx.organizationId` (bound context overrides the caller's value; without one an explicit value is required); dot-path form injects nested Prisma syntax and is not type-checked. */
  tenantField?: TFields | `${string}.${string}`;

  extension?: ExtensionPolicy;

  /** Static WHERE pins (MTI role discriminators) applied on every scoped read and write; scalar entries are auto-filled by `build()`, object-filter entries are not; write pins prevent a role-flip TOCTOU (P2025). */
  discriminator?: Partial<Record<TFields, unknown>>;

  /** Prisma `include` shape auto-merged into every base finder; the Zod schema must declare every relation key listed here or Zod will silently strip it. */
  include?: Record<string, unknown>;

  softDeleteField?: TFields;

  actions?: Record<string, string>;
}

/** Extension FK must be `@id` (FK-as-PK) with `onDelete: Cascade`, and the schema must declare a `z.object(...)` at `relationName`. */
export interface ExtensionPolicy {
  relationName: string;
  extension?: ExtensionPolicy;
}
