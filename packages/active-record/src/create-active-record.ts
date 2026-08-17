import { ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@repo/database';
import { z } from 'zod';
import { ActiveRecordRegistry } from './active-record.registry';
import {
  ChangeSet,
  ExtensionPolicy,
  LeafChange,
  PermissionContextRequiredError,
  RecordNotFoundError,
  RecordPolicy,
  RecordState,
  SaveOptions,
  TenantContextRequiredError,
} from './active-record.types';

type WithId = { id: string };

/** Read methods here must stay in sync with `SCOPED_READ_METHODS` — both describe what the proxy intercepts. */
type PrismaDelegate = {
  findUnique: (args: object) => Promise<unknown>;
  findUniqueOrThrow: (args: object) => Promise<unknown>;
  findFirst: (args: object) => Promise<unknown>;
  findFirstOrThrow: (args: object) => Promise<unknown>;
  findMany: (args?: object) => Promise<unknown[]>;
  count: (args?: object) => Promise<unknown>;
  aggregate: (args: object) => Promise<unknown>;
  groupBy: (args: object) => Promise<unknown>;
  create: (args: object) => Promise<unknown>;
  update: (args: object) => Promise<unknown>;
  delete: (args: object) => Promise<unknown>;
};

export type PrismaModelName = Exclude<Extract<keyof PrismaClient, string>, `$${string}`>;

type ResolveDelegate<TModelName extends string> = TModelName extends PrismaModelName
  ? PrismaClient[TModelName]
  : PrismaDelegate;

type SchemaTopLevelKeys<TSchema extends z.ZodObject<z.ZodRawShape>> = Extract<keyof z.infer<TSchema>, string>;

type DeepPartial<T> = T extends Date | RegExp | Prisma.Decimal
  ? T
  : T extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

/** Every read method accepting `where` must be listed here — omissions silently bypass tenant scoping. */
const SCOPED_READ_METHODS = new Set<string>([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const BULK_WRITE_METHODS = new Set<string>(['updateMany', 'deleteMany', 'createMany', 'upsert']);

type ReadPins = {
  tenant: { path: string[] } | null;
  discriminators: ReadonlyArray<{ key: string; value: unknown }>;
  softDelete: { key: string } | null;
};

function injectReadScope(args: Record<string, unknown>, pins: ReadPins, modelName: string): Record<string, unknown> {
  let where = (args.where ?? {}) as Record<string, unknown>;
  const ctx = ActiveRecordRegistry.context;

  if (pins.tenant) {
    if (ctx) {
      where = setValueAtPath(where, pins.tenant.path, ctx.organizationId);
    } else if (!hasDefinedValueAtPath(where, pins.tenant.path)) {
      throw new TenantContextRequiredError(modelName, pins.tenant.path.join('.'));
    }
  }

  for (const { key, value } of pins.discriminators) {
    where = { ...where, [key]: value };
  }

  if (pins.softDelete && !(pins.softDelete.key in where)) {
    where = { ...where, [pins.softDelete.key]: null };
  }

  return { ...args, where };
}

function hasDefinedValueAtPath(obj: Record<string, unknown>, path: string[]): boolean {
  let cursor: unknown = obj;
  for (const segment of path) {
    if (typeof cursor !== 'object' || cursor === null) return false;
    if (!(segment in (cursor as Record<string, unknown>))) return false;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor !== undefined;
}

function setValueAtPath(obj: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  if (path.length === 1) {
    return { ...obj, [path[0]]: value };
  }
  const [head, ...rest] = path;
  const existing = obj[head];
  const child = typeof existing === 'object' && existing !== null ? (existing as Record<string, unknown>) : {};
  return { ...obj, [head]: setValueAtPath(child, rest, value) };
}

function buildReadPins(
  policy: RecordPolicy | undefined,
  flags: { applyTenant: boolean; applySoftDelete: boolean },
): ReadPins {
  return {
    tenant: flags.applyTenant && policy?.tenantField ? { path: policy.tenantField.split('.') } : null,
    discriminators: policy?.discriminator
      ? Object.entries(policy.discriminator)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => ({ key, value }))
      : [],
    softDelete: flags.applySoftDelete && policy?.softDeleteField ? { key: policy.softDeleteField } : null,
  };
}

function scopedDelegate<D extends object>(raw: D, pins: ReadPins, modelName: string): D {
  if (!pins.tenant && pins.discriminators.length === 0 && !pins.softDelete) {
    return raw;
  }
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && SCOPED_READ_METHODS.has(prop)) {
        return async (args?: object) => {
          const scoped = injectReadScope((args ?? {}) as Record<string, unknown>, pins, modelName);
          const realMethod = Reflect.get(target, prop, receiver) as ((args: unknown) => unknown) | undefined;
          if (typeof realMethod !== 'function') {
            throw new TypeError(`${modelName}: delegate.${prop} is not implemented`);
          }
          return realMethod.call(target, scoped);
        };
      }

      if (typeof prop === 'string' && BULK_WRITE_METHODS.has(prop)) {
        return async () => {
          throw new Error(
            `${modelName}.${prop}() is not tenant-scoped — bulk writes bypass the tenant, discriminator, and ` +
              `soft-delete pins. If you intend an unscoped bulk write, use the raw client ` +
              `(ActiveRecordRegistry.client.${modelName}.${prop}) with an explicit WHERE.`,
          );
        };
      }

      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return value.bind(target);
    },
  });
}

function checkPermission(permissionKey: string): void {
  const ctx = ActiveRecordRegistry.context;
  // Fail closed on no context — mirrors tenant scoping.
  if (!ctx) throw new PermissionContextRequiredError(permissionKey);

  const denied = !ctx.system && !ctx.permissions?.has(permissionKey);
  // Before the system short-circuit: system writes are in audit scope even though they bypass the gate.
  ctx.onPermissionCheck?.(permissionKey, denied);

  if (ctx.system) return;

  if (denied) {
    throw new ForbiddenException(`You do not have permission to perform this action (requires ${permissionKey})`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function validateExtensionPolicy(
  schemaShape: z.ZodRawShape,
  policy: ExtensionPolicy | undefined,
  modelName: string,
  path: string[] = [],
): void {
  if (!policy) return;
  const at = path.length === 0 ? modelName : `${modelName}.${path.join('.')}`;
  const declared = schemaShape[policy.relationName];
  if (!declared) {
    throw new Error(
      `createActiveRecord(${modelName}): extension relation "${policy.relationName}" is not declared in the schema ` +
        `at ${at}. Add it as a nested z.object({ ... }) keyed by "${policy.relationName}" so reads, set(), and ` +
        `save() know where the extension's data lives.`,
    );
  }
  const inner = unwrapToObject(declared);
  if (!inner) {
    throw new Error(
      `createActiveRecord(${modelName}): extension relation "${policy.relationName}" at ${at} must be declared as ` +
        `a z.object({ ... }). Found a different Zod type — the framework needs an object shape to walk into for ` +
        `chained extensions and to use as the nested-write target for save().`,
    );
  }
  validateExtensionPolicy(inner.shape, policy.extension, modelName, [...path, policy.relationName]);
}

function unwrapToObject(t: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | null {
  let current: z.ZodTypeAny = t;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) {
    current = current._def.innerType;
  }
  return current instanceof z.ZodObject ? (current as z.ZodObject<z.ZodRawShape>) : null;
}

function buildExtensionInclude(policy: ExtensionPolicy | undefined): Record<string, unknown> | undefined {
  if (!policy) return undefined;
  const nested = buildExtensionInclude(policy.extension);
  return {
    [policy.relationName]: nested ? { include: nested } : true,
  };
}

function mergeIncludes(
  callerInclude: Record<string, unknown>,
  frameworkInclude: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...callerInclude };
  for (const [key, frameworkValue] of Object.entries(frameworkInclude)) {
    const callerValue = merged[key];

    if (callerValue === undefined) {
      merged[key] = frameworkValue;
      continue;
    }

    if (frameworkValue === true) {
      continue;
    }

    if (!isPlainObject(frameworkValue)) {
      continue;
    }

    if (!isPlainObject(callerValue)) {
      merged[key] = frameworkValue;
      continue;
    }

    const frameworkSubInclude = isPlainObject(frameworkValue.include)
      ? (frameworkValue.include as Record<string, unknown>)
      : undefined;
    if (!frameworkSubInclude) {
      continue;
    }
    const callerSubInclude = isPlainObject(callerValue.include) ? (callerValue.include as Record<string, unknown>) : {};
    merged[key] = {
      ...callerValue,
      include: mergeIncludes(callerSubInclude, frameworkSubInclude),
    };
  }
  return merged;
}

function deepMergeWithChanges(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
  changes: Record<string, unknown>,
  policy: ExtensionPolicy | undefined,
): void {
  for (const [key, newValue] of Object.entries(patch)) {
    const isExtensionKey = !!policy && key === policy.relationName;
    const targetIsObject = isPlainObject(target[key]);
    const patchIsObject = isPlainObject(newValue);

    if (isExtensionKey && patchIsObject) {
      if (!targetIsObject) target[key] = {};
      const existingBranch = changes[key];
      let branch: Record<string, unknown>;
      if (isPlainObject(existingBranch) && !isLeafChange(existingBranch)) {
        branch = existingBranch;
      } else {
        branch = {};
        changes[key] = branch;
      }
      deepMergeWithChanges(target[key] as Record<string, unknown>, newValue, branch, policy?.extension);
      continue;
    }

    const existing = changes[key];
    if (isPlainObject(existing) && isLeafChange(existing)) {
      existing.to = newValue;
    } else {
      changes[key] = makeLeafChange(target[key], newValue);
    }
    target[key] = newValue;
  }
}

const LEAF_CHANGE_BRAND: unique symbol = Symbol('activeRecord.leafChange');
function makeLeafChange(from: unknown, to: unknown): { from: unknown; to: unknown } {
  const leaf = { from, to };
  Object.defineProperty(leaf, LEAF_CHANGE_BRAND, { value: true, enumerable: false });
  return leaf;
}

export function isLeafChange<V>(entry: LeafChange<V> | ChangeSet<V>): entry is LeafChange<V>;
export function isLeafChange<V = unknown>(entry: unknown): entry is LeafChange<V>;
export function isLeafChange(entry: unknown): boolean {
  return typeof entry === 'object' && entry !== null && Object.prototype.hasOwnProperty.call(entry, LEAF_CHANGE_BRAND);
}

function changesHaveAnyLeaf(changes: Record<string, unknown>): boolean {
  for (const value of Object.values(changes)) {
    if (!isPlainObject(value)) continue;
    if (isLeafChange(value)) return true;
    if (changesHaveAnyLeaf(value)) return true;
  }
  return false;
}

/** Never skips a level — every row must be created even when data is `{}` (Prisma fills defaults). */
function buildNestedCreateFromData(
  data: Record<string, unknown>,
  policy: ExtensionPolicy | undefined,
): Record<string, unknown> {
  if (!policy) return data;
  const { [policy.relationName]: extensionData, ...baseData } = data;
  const innerData = isPlainObject(extensionData) ? extensionData : {};
  const nested = buildNestedCreateFromData(innerData, policy.extension);
  return {
    ...baseData,
    [policy.relationName]: { create: nested },
  };
}

function buildNestedUpdateFromChanges(
  changes: Record<string, unknown>,
  policy: ExtensionPolicy | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (!isPlainObject(value)) continue;
    if (isLeafChange(value)) {
      out[key] = value.to;
      continue;
    }
    if (policy && key === policy.relationName) {
      const inner = buildNestedUpdateFromChanges(value, policy.extension);
      if (Object.keys(inner).length === 0) continue;
      out[key] = { update: inner };
    } else {
      out[key] = value;
    }
  }
  return out;
}

export function createActiveRecord<TSchema extends z.ZodObject<z.ZodRawShape>, TModelName extends string>(
  schema: TSchema,
  modelName: TModelName,
  policy?: RecordPolicy<SchemaTopLevelKeys<TSchema>>,
) {
  type Data = z.infer<TSchema>;
  type ModelDelegate = ResolveDelegate<TModelName>;

  validateExtensionPolicy(schema.shape, policy?.extension, modelName);

  if (policy?.discriminator) {
    for (const key of Object.keys(policy.discriminator)) {
      if (!(key in schema.shape)) {
        throw new Error(
          `createActiveRecord(${modelName}): discriminator key "${key}" is not declared on the schema. ` +
            `Discriminator keys must be top-level columns on the record's Zod schema so the framework can ` +
            `auto-fill them in build() and pin them on read/write WHERE clauses.`,
        );
      }
    }
  }
  if (policy?.softDeleteField && !(policy.softDeleteField in schema.shape)) {
    throw new Error(
      `createActiveRecord(${modelName}): softDeleteField "${policy.softDeleteField}" is not declared on the ` +
        `schema. The soft-delete pin defaults the column to null on scoped reads, so it must be a real top-level ` +
        `column on the record's Zod schema.`,
    );
  }

  const extensionInclude = buildExtensionInclude(policy?.extension);
  const baseAutoInclude = (() => {
    if (!extensionInclude && !policy?.include) return undefined;
    if (!extensionInclude) return policy!.include;
    if (!policy?.include) return extensionInclude;
    return mergeIncludes(policy.include, extensionInclude);
  })();

  const readPinsScoped = buildReadPins(policy, { applyTenant: true, applySoftDelete: true });
  const readPinsScopedIncludingDeleted = buildReadPins(policy, {
    applyTenant: true,
    applySoftDelete: false,
  });
  const readPinsUnscoped = buildReadPins(policy, { applyTenant: false, applySoftDelete: true });
  const readPinsUnscopedIncludingDeleted = buildReadPins(policy, {
    applyTenant: false,
    applySoftDelete: false,
  });

  const discriminatorEntries: ReadonlyArray<{ key: string; value: unknown }> = policy?.discriminator
    ? Object.entries(policy.discriminator)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => ({ key, value }))
    : [];
  const scalarDiscriminatorEntries: ReadonlyArray<{ key: string; value: unknown }> = discriminatorEntries.filter(
    ({ value }) => !isPlainObject(value),
  );

  class BaseRecord {
    _data: Data;
    _state: RecordState;
    _changes: ChangeSet<Data> = {};

    protected constructor(data: unknown, state: RecordState = 'persisted') {
      this._data = state === 'new' ? (data as Data) : schema.parse(data);
      this._state = state;

      if (policy?.actions) {
        return this._withPolicyProxy();
      }
    }

    _withPolicyProxy(): this {
      const actions = policy!.actions!;

      return new Proxy(this, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== 'function') return value;
          if (typeof prop !== 'string') return value;

          const permissionKey = actions[prop];
          return function (...args: unknown[]) {
            if (permissionKey) checkPermission(permissionKey);
            const result = (value as (...a: unknown[]) => unknown).apply(target, args);
            // Methods returning `this` must hand back the proxy, not the unwrapped target, so chaining stays gated and reference-equal.
            if (result instanceof Promise) {
              return result.then((resolved) => (resolved === target ? receiver : resolved));
            }
            return result === target ? receiver : result;
          };
        },
      });
    }

    static requireAction(actionName: string): void {
      if (!policy?.actions) return;
      const permissionKey = policy.actions[actionName];
      if (!permissionKey) return;
      checkPermission(permissionKey);
    }

    /** Uses `findFirst` because relation-path tenant policies inject nested syntax that `findUnique` rejects. */
    static async findById(id: string, opts?: Pick<SaveOptions, 'tx'> & { includeDeleted?: boolean }): Promise<any> {
      const delegate = this._looseDelegate(opts?.tx, { includeDeleted: opts?.includeDeleted });
      const row = await delegate.findFirst(this._withExtensionInclude({ where: { id } }));
      if (!row) return null;
      return new this(row, 'persisted');
    }

    static async findOne(args: object, opts?: Pick<SaveOptions, 'tx'> & { includeDeleted?: boolean }): Promise<any> {
      const delegate = this._looseDelegate(opts?.tx, { includeDeleted: opts?.includeDeleted });
      const row = await delegate.findFirst(this._withExtensionInclude(args));
      if (!row) return null;
      return new this(row, 'persisted');
    }

    static async findMany(
      args?: object,
      opts?: Pick<SaveOptions, 'tx'> & { includeDeleted?: boolean },
    ): Promise<any[]> {
      const delegate = this._looseDelegate(opts?.tx, { includeDeleted: opts?.includeDeleted });
      const rows = await delegate.findMany(this._withExtensionInclude(args ?? {}));
      return rows.map((row) => new this(row, 'persisted'));
    }

    static async findByIdUnscoped(
      id: string,
      opts?: Pick<SaveOptions, 'tx'> & { includeDeleted?: boolean },
    ): Promise<any> {
      const delegate = this._unscopedLooseDelegate(opts?.tx, {
        includeDeleted: opts?.includeDeleted,
      });
      const row = await delegate.findUnique(this._withExtensionInclude({ where: { id } }));
      if (!row) return null;
      return new this(row, 'persisted');
    }

    static async findOneUnscoped(
      args: object,
      opts?: Pick<SaveOptions, 'tx'> & { includeDeleted?: boolean },
    ): Promise<any> {
      const delegate = this._unscopedLooseDelegate(opts?.tx, {
        includeDeleted: opts?.includeDeleted,
      });
      const row = await delegate.findFirst(this._withExtensionInclude(args));
      if (!row) return null;
      return new this(row, 'persisted');
    }

    static async findManyUnscoped(
      args?: object,
      opts?: Pick<SaveOptions, 'tx'> & { includeDeleted?: boolean },
    ): Promise<any[]> {
      const delegate = this._unscopedLooseDelegate(opts?.tx, {
        includeDeleted: opts?.includeDeleted,
      });
      const rows = await delegate.findMany(this._withExtensionInclude(args ?? {}));
      return rows.map((row) => new this(row, 'persisted'));
    }

    /** The row must include the full extension chain (Zod throws otherwise); returns `any` due to polymorphic-this/constructor conflict. */
    static fromRow(row: unknown): any {
      return new this(row, 'persisted');
    }

    static build(data: DeepPartial<Data>): any {
      const built = { ...data } as Record<string, unknown>;

      if (policy?.tenantField && !policy.tenantField.includes('.')) {
        if (!(policy.tenantField in built)) {
          const ctx = ActiveRecordRegistry.context;
          if (!ctx) {
            throw new TenantContextRequiredError(modelName, policy.tenantField);
          }
          built[policy.tenantField] = ctx.organizationId;
        }
      }

      for (const { key, value } of scalarDiscriminatorEntries) {
        if (!(key in built)) {
          built[key] = value;
        }
      }

      return new this(built, 'new');
    }

    get data(): Readonly<Data> {
      return this._data;
    }
    get state(): RecordState {
      return this._state;
    }
    get isNew(): boolean {
      return this._state === 'new';
    }
    get isPersisted(): boolean {
      return this._state === 'persisted';
    }
    get isDeleted(): boolean {
      return this._state === 'deleted';
    }
    get isDirty(): boolean {
      return changesHaveAnyLeaf(this._changes as Record<string, unknown>);
    }
    get changes(): Readonly<ChangeSet<Data>> {
      return this._changes;
    }

    set(patch: DeepPartial<Data>): this {
      deepMergeWithChanges(
        this._data as Record<string, unknown>,
        patch as Record<string, unknown>,
        this._changes as Record<string, unknown>,
        policy?.extension,
      );
      return this;
    }

    /** Flat tenant sourced from record data (safe in background jobs), relation-path tenant from ctx; discriminators prevent write-side TOCTOU; `softDeleteField` deliberately excluded. */
    _scopeWhere(): Record<string, unknown> {
      let where: Record<string, unknown> = { id: (this._data as WithId).id };

      if (policy?.tenantField) {
        if (!policy.tenantField.includes('.')) {
          const tenantValue = (this._data as Record<string, unknown>)[policy.tenantField];
          if (tenantValue !== undefined) {
            where[policy.tenantField] = tenantValue;
          }
        } else {
          const ctx = ActiveRecordRegistry.context;
          if (ctx) {
            where = setValueAtPath(where, policy.tenantField.split('.'), ctx.organizationId);
          }
        }
      }

      for (const { key, value } of discriminatorEntries) {
        where[key] = value;
      }

      return where;
    }

    async save(opts?: SaveOptions): Promise<this> {
      if (this._state === 'deleted') {
        throw new Error('Cannot save a deleted record.');
      }

      const delegate = (this.constructor as typeof BaseRecord)._unscopedLooseDelegate(opts?.tx);
      const ext = policy?.extension;

      if (this._state === 'new') {
        if (ext) {
          const created = await delegate.create({
            data: buildNestedCreateFromData(this._data as Record<string, unknown>, ext),
            include: baseAutoInclude,
          });
          this._data = schema.parse(created);
        } else {
          const created = baseAutoInclude
            ? await delegate.create({ data: this._data as object, include: baseAutoInclude })
            : await delegate.create({ data: this._data as object });
          this._data = schema.parse(created);
        }
        this._state = 'persisted';
        this._changes = {};
      } else if (this.isDirty) {
        const updateData = ext
          ? buildNestedUpdateFromChanges(this._changes as Record<string, unknown>, ext)
          : Object.fromEntries(Object.entries(this._changes).map(([k, v]) => [k, (v as { to: unknown }).to]));

        try {
          const updated = baseAutoInclude
            ? await delegate.update({
                where: this._scopeWhere(),
                data: updateData,
                include: baseAutoInclude,
              })
            : await delegate.update({
                where: this._scopeWhere(),
                data: updateData,
              });
          this._data = schema.parse(updated);
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
            throw new RecordNotFoundError(modelName, (this._data as WithId).id);
          }
          throw error;
        }
        this._changes = {};
      }

      return this;
    }

    async delete(opts?: SaveOptions): Promise<void> {
      if (this._state !== 'persisted') {
        throw new Error('Only persisted records can be deleted.');
      }
      const delegate = (this.constructor as typeof BaseRecord)._unscopedLooseDelegate(opts?.tx);

      if (policy?.softDeleteField) {
        const softDeleteData = { [policy.softDeleteField]: new Date() };
        try {
          const updated = baseAutoInclude
            ? await delegate.update({ where: this._scopeWhere(), data: softDeleteData, include: baseAutoInclude })
            : await delegate.update({ where: this._scopeWhere(), data: softDeleteData });
          this._data = schema.parse(updated);
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
            throw new RecordNotFoundError(modelName, (this._data as WithId).id);
          }
          throw error;
        }
        this._changes = {};
        this._state = 'deleted';
        return;
      }

      try {
        await delegate.delete({ where: this._scopeWhere() });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          throw new RecordNotFoundError(modelName, (this._data as WithId).id);
        }
        throw error;
      }
      this._state = 'deleted';
    }

    toJSON(): Data {
      return this._data;
    }

    static _delegate(tx?: Prisma.TransactionClient, opts?: { includeDeleted?: boolean }): ModelDelegate {
      const client = tx ?? ActiveRecordRegistry.client;
      const raw = (client as unknown as Record<string, ModelDelegate>)[modelName];
      const pins = opts?.includeDeleted ? readPinsScopedIncludingDeleted : readPinsScoped;
      return scopedDelegate(raw, pins, modelName);
    }

    static _looseDelegate(tx?: Prisma.TransactionClient, opts?: { includeDeleted?: boolean }): PrismaDelegate {
      return this._delegate(tx, opts) as unknown as PrismaDelegate;
    }

    static _unscopedDelegate(tx?: Prisma.TransactionClient, opts?: { includeDeleted?: boolean }): ModelDelegate {
      const client = tx ?? ActiveRecordRegistry.client;
      const raw = (client as unknown as Record<string, ModelDelegate>)[modelName];
      const pins = opts?.includeDeleted ? readPinsUnscopedIncludingDeleted : readPinsUnscoped;
      return scopedDelegate(raw, pins, modelName);
    }

    static _unscopedLooseDelegate(tx?: Prisma.TransactionClient, opts?: { includeDeleted?: boolean }): PrismaDelegate {
      return this._unscopedDelegate(tx, opts) as unknown as PrismaDelegate;
    }

    static _paginationDelegate<T = Data>(opts?: {
      tx?: Prisma.TransactionClient;
      includeDeleted?: boolean;
      schema?: z.ZodTypeAny;
    }): {
      findMany: (args: object) => Promise<T[]>;
      count: (args: object) => Promise<number>;
    } {
      const rowSchema = opts?.schema ?? schema;
      const delegate = this._looseDelegate(opts?.tx, { includeDeleted: opts?.includeDeleted });
      return {
        findMany: async (args: object): Promise<T[]> => {
          const rows = await delegate.findMany(this._withExtensionInclude(args));
          return rows.map((row) => rowSchema.parse(row) as unknown as T);
        },
        count: async (args: object): Promise<number> => {
          const total = await delegate.count(args);
          return total as number;
        },
      };
    }

    static _withExtensionInclude(args: object): object {
      if (!baseAutoInclude) return args;
      const callerInclude =
        'include' in args && isPlainObject((args as { include: unknown }).include)
          ? (args as { include: Record<string, unknown> }).include
          : undefined;
      if (!callerInclude) {
        return { ...args, include: baseAutoInclude };
      }
      return { ...args, include: mergeIncludes(callerInclude, baseAutoInclude) };
    }
  }

  return BaseRecord;
}
