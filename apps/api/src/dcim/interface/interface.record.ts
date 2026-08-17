import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { INTERFACE_NAME_MESSAGE, INTERFACE_NAME_REGEX, MAC_ADDRESS_REGEX } from '@repo/api-client';
import { InterfaceLinkType, InterfaceMode, InterfaceType, Prisma } from '@repo/database';
import { formatMacAddress } from '@repo/database/extensions/mac-address';
import type { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { z } from 'zod';
import { assertParentDeviceOwnedOrSupplied, assertParentDeviceReachable } from '../parent-device.utils';
import { interfacePaginationConfig } from './interface.pagination';

const VIRTUAL_INTERFACE_TYPE_VALUES: ReadonlySet<string> = new Set([InterfaceType.VIRTUAL, InterfaceType.BOND]);
const MIN_MTU = 68;
const MAX_MTU = 65536;

export const InterfacePersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
  enabled: z.boolean(),
  mtu: z.number().nullable(),
  macAddress: z.string().nullable(),
  speed: z.number().nullable(),
  mgmtOnly: z.boolean(),
  markConnected: z.boolean(),
  mode: z.string().nullable(),
  description: z.string().nullable(),
  linkType: z.string().nullable(),
  guid: z.string().nullable(),
  portState: z.string().nullable(),
  maxSpeedGbps: z.number().nullable(),
  pciDeviceId: z.string().nullable(),
  lldpNeighborName: z.string().nullable(),
  lldpNeighborPort: z.string().nullable(),
  lldpNeighborDescr: z.string().nullable(),
  lldpNeighborMgmtIp: z.string().nullable(),
  deviceId: z.string(),
  lagId: z.string().nullable(),
  parentId: z.string().nullable(),
  untaggedVlanId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateInterfaceInput {
  name: string;
  type?: InterfaceType | null;
  enabled?: boolean;
  mtu?: number | null;
  macAddress?: string | null;
  speed?: number | null;
  mgmtOnly?: boolean;
  markConnected?: boolean;
  mode?: InterfaceMode | null;
  description?: string | null;
  linkType?: InterfaceLinkType | null;
  guid?: string | null;
  portState?: string | null;
  maxSpeedGbps?: number | null;
  pciDeviceId?: string | null;
  lldpNeighborName?: string | null;
  lldpNeighborPort?: string | null;
  lldpNeighborDescr?: string | null;
  lldpNeighborMgmtIp?: string | null;
  lagId?: string | null;
  parentId?: string | null;
  untaggedVlanId?: string | null;
}

export interface UpdateInterfaceInput {
  name?: string;
  type?: InterfaceType | null;
  enabled?: boolean;
  mtu?: number | null;
  macAddress?: string | null;
  speed?: number | null;
  mgmtOnly?: boolean;
  markConnected?: boolean;
  mode?: InterfaceMode | null;
  description?: string | null;
  linkType?: InterfaceLinkType | null;
  guid?: string | null;
  portState?: string | null;
  maxSpeedGbps?: number | null;
  pciDeviceId?: string | null;
  lldpNeighborName?: string | null;
  lldpNeighborPort?: string | null;
  lldpNeighborDescr?: string | null;
  lldpNeighborMgmtIp?: string | null;
  lagId?: string | null;
  parentId?: string | null;
  untaggedVlanId?: string | null;
}

interface BulkInterfaceOps {
  deletes: string[];
  updates: Array<{ id: string; data: UpdateInterfaceInput }>;
  creates: CreateInterfaceInput[];
}

const interfaceWithIpsInclude = {
  ipAddresses: {
    where: { deletedAt: null },
    select: { id: true, address: true, status: true },
  },
} satisfies Prisma.InterfaceInclude;
export type InterfaceWithIps = Prisma.InterfaceGetPayload<{ include: typeof interfaceWithIpsInclude }>;

// Tenant-facing record scoped via the parent device.supplierId relation-path policy (see RearPortRecord for the supplier-scope semantics); admin/cross-supplier operations live on AdminInterfaceRecord.
// The invariant checks below are exported pure functions so AdminInterfaceRecord reuses them; the same-device check runs in each record via its own scope-appropriate lookup + assertReferencedInterfaceMatchesDevice.
export class InterfaceRecord extends createActiveRecord(InterfacePersistenceSchema, 'interface', {
  tenantField: 'device.supplierId',
  actions: { read: 'dcim:read', create: 'dcim:create', update: 'dcim:update', delete: 'dcim:delete' },
}) {
  static async listPaginated(query: PaginationQuery): Promise<PaginatedResult<InterfaceRecord>> {
    this.requireAction('read');
    const result = await paginateQuery<z.infer<typeof InterfacePersistenceSchema>>(
      this._delegate(),
      query,
      interfacePaginationConfig,
    );
    return {
      ...result,
      data: result.data.map((row) => this.fromRow(row)),
    };
  }

  static async findByIdOrThrow(id: string): Promise<InterfaceRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('Interface not found');
    }
    return record;
  }

  static async createForDevice(deviceId: string, input: CreateInterfaceInput): Promise<InterfaceRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    await assertParentDeviceReachable(deviceId, ctx.organizationId);
    assertValidInterfaceName(input.name);
    await this.ensureNameUnique(deviceId, input.name);

    assertValidMtu(input.mtu);
    assertValidMacAddress(input.macAddress);
    assertNoSelfReference(null, input.lagId, input.parentId);
    assertParentRequiresVirtualType(input.type, input.parentId);
    assertVirtualCannotHaveLag(input.type, input.lagId);

    if (input.lagId) {
      await this.assertReferenceOnSameDevice(input.lagId, deviceId, 'LAG');
    }
    if (input.parentId) {
      await this.assertReferenceOnSameDevice(input.parentId, deviceId, 'parent');
    }
    if (input.untaggedVlanId) {
      await assertUntaggedVlanReachable(input.untaggedVlanId, ctx.organizationId);
    }

    // Share the single-create field projection with the bulk path so a new column is added once.
    const delegate = this._unscopedDelegate();
    const created = await delegate.create({ data: toBulkCreateData(deviceId, input) });
    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateInterfaceInput): Promise<InterfaceRecord> {
    this.requireAction('update');
    const record = await this.findByIdOrThrow(id);

    if (input.name !== undefined) {
      assertValidInterfaceName(input.name);
      await this.ensureNameUnique(record.data.deviceId, input.name, id);
    }

    const effectiveMtu = input.mtu !== undefined ? input.mtu : record.data.mtu;
    const effectiveLagId = input.lagId !== undefined ? input.lagId : record.data.lagId;
    const effectiveParentId = input.parentId !== undefined ? input.parentId : record.data.parentId;
    const effectiveType: string | null = input.type !== undefined ? input.type : record.data.type;

    assertValidMtu(effectiveMtu);
    if (input.macAddress !== undefined) assertValidMacAddress(input.macAddress);
    assertNoSelfReference(id, effectiveLagId, effectiveParentId);
    assertParentRequiresVirtualType(effectiveType, effectiveParentId);
    assertVirtualCannotHaveLag(effectiveType, effectiveLagId);

    const lagChanged = input.lagId !== undefined && input.lagId !== record.data.lagId;
    const parentChanged = input.parentId !== undefined && input.parentId !== record.data.parentId;
    if (lagChanged && input.lagId) {
      await this.assertReferenceOnSameDevice(input.lagId, record.data.deviceId, 'LAG');
    }
    if (parentChanged && input.parentId) {
      await this.assertReferenceOnSameDevice(input.parentId, record.data.deviceId, 'parent');
    }
    const untaggedVlanChanged =
      input.untaggedVlanId !== undefined && input.untaggedVlanId !== record.data.untaggedVlanId;
    if (untaggedVlanChanged && input.untaggedVlanId) {
      const ctx = ActiveRecordRegistry.context;
      if (!ctx) {
        throw new BadRequestException('No active organization in request context');
      }
      await assertUntaggedVlanReachable(input.untaggedVlanId, ctx.organizationId);
    }

    // record.save() puts the dotted-policy tenant filter from _scopeWhere() in the update WHERE — defense-in-depth matching the rest of the DCIM port records.
    // Normalize the MAC (trim; blank → null "no MAC"); null/undefined pass through untouched.
    record.set(typeof input.macAddress === 'string' ? { ...input, macAddress: normalizeMac(input.macAddress) } : input);
    await record.save();
    return record;
  }

  static async deleteById(id: string): Promise<void> {
    this.requireAction('delete');
    const record = await this.findByIdOrThrow(id);
    // Retire assigned IPs first: the hard delete FK-nulls interfaceId but leaves the IP rows ACTIVE with a stale assignedObjectId.
    const client = ActiveRecordRegistry.client;
    await client.$transaction(async (tx) => {
      await tx.ipAddress.updateMany({
        where: { interfaceId: id, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await record.delete({ tx });
    });
  }

  // The unscoped by-device query is safe only because assertParentDeviceOwnedOrSupplied confirms the device is the caller's first.
  static async listForDeviceWithIps(deviceId: string): Promise<InterfaceWithIps[]> {
    this.requireAction('read');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    // Owner-OR-supplier: servers are supplier-scoped, bridges owner-scoped.
    await assertParentDeviceOwnedOrSupplied(deviceId, ctx.organizationId);
    return ActiveRecordRegistry.client.interface.findMany({
      where: { deviceId, deletedAt: null },
      include: interfaceWithIpsInclude,
      orderBy: { name: 'asc' },
    });
  }

  static async bulkApplyForDevice(deviceId: string, ops: BulkInterfaceOps): Promise<void> {
    // Baseline gate that always fires: an all-empty payload would otherwise skip every action check
    // below, letting a permission-less org context reach device-ownership validation (a minor oracle).
    this.requireAction('read');
    if (ops.creates.length > 0) this.requireAction('create');
    if (ops.updates.length > 0) this.requireAction('update');
    if (ops.deletes.length > 0) this.requireAction('delete');

    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    // Owner-OR-supplier: servers are supplier-scoped, bridges owner-scoped.
    await assertParentDeviceOwnedOrSupplied(deviceId, ctx.organizationId);

    const client = ActiveRecordRegistry.client;
    const current = await client.interface.findMany({
      where: { deviceId, deletedAt: null },
      select: { id: true, name: true, type: true, mtu: true, lagId: true, parentId: true, untaggedVlanId: true },
    });
    const byId = new Map(current.map((i) => [i.id, i]));

    // An id in both deletes and updates would delete then update in the tx,
    // hitting P2025 mid-transaction (a 500). Reject it up front as a 400.
    const deleteIds = new Set(ops.deletes);
    const conflicting = ops.updates.find((u) => deleteIds.has(u.id));
    if (conflicting) {
      throw new BadRequestException(`Interface ${conflicting.id} cannot be both updated and deleted`);
    }

    // deleteMany runs first in the tx, so a create/update referencing a deleted id would FK-crash (500) — reject as 400 up front.
    const referencesDeleted = (refId: string | null | undefined): boolean => !!refId && deleteIds.has(refId);
    for (const c of ops.creates) {
      if (referencesDeleted(c.lagId) || referencesDeleted(c.parentId)) {
        throw new BadRequestException('Cannot reference an interface that is being deleted in the same request');
      }
    }
    for (const { data } of ops.updates) {
      if (referencesDeleted(data.lagId) || referencesDeleted(data.parentId)) {
        throw new BadRequestException('Cannot reference an interface that is being deleted in the same request');
      }
    }

    // Deletes must exist up front (they run as a deleteMany in the tx). Update existence is checked
    // in the per-update loop below, where `existing` is also read to evaluate domain invariants.
    for (const id of ops.deletes) {
      if (!byId.has(id)) throw new NotFoundException(`Interface ${id} not found on this device`);
    }

    // A hard delete cascades SET NULL onto referencing lagId/parentId — a silent binding wipe unless the
    // batch itself clears/reassigns those refs; reject so the caller opts in explicitly.
    if (ops.deletes.length > 0) {
      const updatedData = new Map(ops.updates.map((u) => [u.id, u.data]));
      const orphaned = current.filter((i) => {
        if (deleteIds.has(i.id)) return false;
        const u = updatedData.get(i.id);
        const effLagId = u && u.lagId !== undefined ? u.lagId : i.lagId;
        const effParentId = u && u.parentId !== undefined ? u.parentId : i.parentId;
        return referencesDeleted(effLagId) || referencesDeleted(effParentId);
      });
      if (orphaned.length > 0) {
        throw new BadRequestException(
          `Deleting these interfaces would clear lagId/parentId on: ${orphaned.map((o) => o.name).join(', ')}. ` +
            'Include those interfaces in updates to clear or reassign the references.',
        );
      }
    }

    // Validate refs against byId, not the supplier-scoped finder — that finder returns nothing for a
    // bridge the caller owns but doesn't supply, wrongly rejecting valid on-device refs.
    const assertRefOnDevice = (refId: string | null | undefined, label: string): void => {
      if (refId && !byId.has(refId)) {
        throw new BadRequestException(`${label} interface must belong to the same device`);
      }
    };

    // Same domain invariants the single-row create/update paths enforce.
    for (const c of ops.creates) {
      assertValidInterfaceName(c.name);
      assertValidMtu(c.mtu);
      assertValidMacAddress(c.macAddress);
      assertNoSelfReference(null, c.lagId, c.parentId);
      assertParentRequiresVirtualType(c.type, c.parentId);
      assertVirtualCannotHaveLag(c.type, c.lagId);
      assertRefOnDevice(c.lagId, 'LAG');
      assertRefOnDevice(c.parentId, 'parent');
      if (c.untaggedVlanId) await assertUntaggedVlanReachable(c.untaggedVlanId, ctx.organizationId);
    }
    for (const { id, data } of ops.updates) {
      const existing = byId.get(id);
      if (!existing) throw new NotFoundException(`Interface ${id} not found on this device`);
      const effType: string | null = data.type !== undefined ? data.type : existing.type;
      const effLagId = data.lagId !== undefined ? data.lagId : existing.lagId;
      const effParentId = data.parentId !== undefined ? data.parentId : existing.parentId;
      if (data.name !== undefined) assertValidInterfaceName(data.name);
      assertValidMtu(data.mtu !== undefined ? data.mtu : existing.mtu);
      if (data.macAddress !== undefined) assertValidMacAddress(data.macAddress);
      assertNoSelfReference(id, effLagId, effParentId);
      assertParentRequiresVirtualType(effType, effParentId);
      assertVirtualCannotHaveLag(effType, effLagId);
      if (data.lagId !== undefined && data.lagId !== existing.lagId) assertRefOnDevice(data.lagId, 'LAG');
      if (data.parentId !== undefined && data.parentId !== existing.parentId) {
        assertRefOnDevice(data.parentId, 'parent');
      }
      if (data.untaggedVlanId !== undefined && data.untaggedVlanId !== existing.untaggedVlanId && data.untaggedVlanId) {
        await assertUntaggedVlanReachable(data.untaggedVlanId, ctx.organizationId);
      }
    }

    // Post-batch names must be unique per device — this is what legalizes swaps.
    const updateById = new Map(ops.updates.map((u) => [u.id, u.data]));
    const finalNames = new Set<string>();
    const claimName = (name: string) => {
      if (finalNames.has(name)) throw new ConflictException(`Interface name "${name}" must be unique per device`);
      finalNames.add(name);
    };
    for (const i of current) {
      if (deleteIds.has(i.id)) continue;
      claimName(updateById.get(i.id)?.name ?? i.name);
    }
    for (const c of ops.creates) claimName(c.name);

    const renames = ops.updates.filter(({ id, data }) => data.name !== undefined && data.name !== byId.get(id)?.name);
    await client.$transaction(async (tx) => {
      if (ops.deletes.length > 0) {
        // Same IP retirement as deleteById — no active IP row may survive the interface hard delete.
        await tx.ipAddress.updateMany({
          where: { interfaceId: { in: ops.deletes }, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        await tx.interface.deleteMany({ where: { id: { in: ops.deletes }, deviceId } });
      }
      for (const { id } of renames) {
        await tx.interface.update({ where: { id }, data: { name: `__tmp__${id}` } });
      }
      for (const { id, data: input } of ops.updates) {
        // Copy only the fields the caller set (undefined = "leave unchanged"); MAC is canonicalized.
        const data: Prisma.InterfaceUncheckedUpdateInput = {};
        if (input.name !== undefined) data.name = input.name;
        if (input.type !== undefined) data.type = input.type;
        if (input.enabled !== undefined) data.enabled = input.enabled;
        if (input.mtu !== undefined) data.mtu = input.mtu;
        if (input.macAddress !== undefined) data.macAddress = normalizeMac(input.macAddress);
        if (input.speed !== undefined) data.speed = input.speed;
        if (input.mgmtOnly !== undefined) data.mgmtOnly = input.mgmtOnly;
        if (input.markConnected !== undefined) data.markConnected = input.markConnected;
        if (input.mode !== undefined) data.mode = input.mode;
        if (input.description !== undefined) data.description = input.description;
        if (input.linkType !== undefined) data.linkType = input.linkType;
        if (input.guid !== undefined) data.guid = input.guid;
        if (input.portState !== undefined) data.portState = input.portState;
        if (input.maxSpeedGbps !== undefined) data.maxSpeedGbps = input.maxSpeedGbps;
        if (input.pciDeviceId !== undefined) data.pciDeviceId = input.pciDeviceId;
        if (input.lldpNeighborName !== undefined) data.lldpNeighborName = input.lldpNeighborName;
        if (input.lldpNeighborPort !== undefined) data.lldpNeighborPort = input.lldpNeighborPort;
        if (input.lldpNeighborDescr !== undefined) data.lldpNeighborDescr = input.lldpNeighborDescr;
        if (input.lldpNeighborMgmtIp !== undefined) data.lldpNeighborMgmtIp = input.lldpNeighborMgmtIp;
        if (input.lagId !== undefined) data.lagId = input.lagId;
        if (input.parentId !== undefined) data.parentId = input.parentId;
        if (input.untaggedVlanId !== undefined) data.untaggedVlanId = input.untaggedVlanId;
        await tx.interface.update({ where: { id }, data });
      }
      for (const c of ops.creates) {
        await tx.interface.create({ data: toBulkCreateData(deviceId, c), select: { id: true } });
      }
    });
  }

  private static async ensureNameUnique(deviceId: string, name: string, excludeId?: string) {
    const delegate = this._unscopedDelegate();
    // Only live rows count: the presence reconciler soft-deletes departing NICs to free their names
    // from the partial-unique index, so a tombstone must not block a real create/rename (false 409).
    const existing = await delegate.findFirst({
      where: { deviceId, name, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException('Interface name must be unique per device');
    }
  }

  private static async assertReferenceOnSameDevice(
    referenceId: string,
    expectedDeviceId: string,
    label: 'LAG' | 'parent',
  ): Promise<void> {
    const reference: InterfaceRecord | null = await this.findOne({ where: { id: referenceId } });
    assertReferencedInterfaceMatchesDevice(reference?.data.deviceId, label, expectedDeviceId);
  }
}

async function assertUntaggedVlanReachable(vlanId: string, organizationId: string): Promise<void> {
  const ok = await ActiveRecordRegistry.client.vlan.findUnique({
    where: { id: vlanId, organizationId, deletedAt: null },
    select: { id: true },
  });
  if (!ok) throw new NotFoundException('VLAN not found');
}

export function assertValidMtu(mtu?: number | null): void {
  if (mtu != null && (mtu < MIN_MTU || mtu > MAX_MTU)) {
    throw new BadRequestException(`MTU must be between ${MIN_MTU} and ${MAX_MTU}`);
  }
}

export function assertValidMacAddress(mac?: string | null): void {
  if (mac != null && mac.trim() !== '' && !MAC_ADDRESS_REGEX.test(mac.trim())) {
    throw new BadRequestException('MAC address must be six hex octets separated by ":" or "-"');
  }
}

// assertValidMacAddress checks the TRIMMED value, so store the trimmed value too — consistent even for a caller that bypasses the request schema's own trim; null/undefined (clear / no-op) pass through.
function normalizeMac(mac: string | null | undefined): string | null | undefined {
  if (typeof mac !== 'string') return mac;
  const trimmed = mac.trim();
  // Blank is "no MAC" — persist NULL, not "". Canonicalize via the shared formatMacAddress (the same form the Prisma mac-address write extension applies; passthrough for e.g. InfiniBand GUIDs) so the reconciler's MAC match can't miss a hyphen/uppercase row.
  return trimmed === '' ? null : formatMacAddress(trimmed);
}

// Plausible NIC name: starts alphanumeric, then letters/digits/`._@:-`, 1–15 chars (Linux IFNAMSIZ-1).
// Also a security gate: the UFW renderer interpolates names into iptables shell commands, so rejecting shell metacharacters stops a DCIM-write operator from planting injection in a generated ruleset.
export function isValidInterfaceName(name: string): boolean {
  return INTERFACE_NAME_REGEX.test(name);
}

export function assertValidInterfaceName(name: string): void {
  if (!isValidInterfaceName(name)) {
    throw new BadRequestException(INTERFACE_NAME_MESSAGE);
  }
}

// `id` is null on create (no row to self-reference yet); on update it's the row being mutated.
export function assertNoSelfReference(id: string | null, lagId?: string | null, parentId?: string | null): void {
  if (id && lagId && lagId === id) {
    throw new BadRequestException('Interface cannot be its own LAG');
  }
  if (id && parentId && parentId === id) {
    throw new BadRequestException('Interface cannot be its own parent');
  }
}

export function assertParentRequiresVirtualType(type?: string | null, parentId?: string | null): void {
  if (parentId && type && !VIRTUAL_INTERFACE_TYPE_VALUES.has(type)) {
    throw new BadRequestException('Only virtual interfaces can have a parent');
  }
}

export function assertVirtualCannotHaveLag(type?: string | null, lagId?: string | null): void {
  if (lagId && type && VIRTUAL_INTERFACE_TYPE_VALUES.has(type)) {
    throw new BadRequestException('Virtual interfaces cannot have a parent LAG');
  }
}

/** Treats not-found/invisible the same as wrong-device so foreign-tenant ids don't leak existence. */
export function assertReferencedInterfaceMatchesDevice(
  referenceDeviceId: string | undefined,
  label: 'LAG' | 'parent',
  expectedDeviceId: string,
): void {
  if (referenceDeviceId !== expectedDeviceId) {
    throw new BadRequestException(`${label} interface must belong to the same device`);
  }
}

// Explicit field maps for the raw transactional writes in `bulkApplyForDevice`
// (no `...spread` into Prisma — every field is picked deliberately).
function toBulkCreateData(deviceId: string, input: CreateInterfaceInput): Prisma.InterfaceUncheckedCreateInput {
  return {
    deviceId,
    name: input.name,
    type: input.type ?? undefined,
    enabled: input.enabled ?? true,
    mtu: input.mtu ?? undefined,
    macAddress: normalizeMac(input.macAddress) ?? undefined,
    speed: input.speed ?? undefined,
    mgmtOnly: input.mgmtOnly ?? false,
    markConnected: input.markConnected ?? false,
    mode: input.mode ?? undefined,
    description: input.description ?? undefined,
    linkType: input.linkType ?? undefined,
    guid: input.guid ?? undefined,
    portState: input.portState ?? undefined,
    maxSpeedGbps: input.maxSpeedGbps ?? undefined,
    pciDeviceId: input.pciDeviceId ?? undefined,
    lldpNeighborName: input.lldpNeighborName ?? undefined,
    lldpNeighborPort: input.lldpNeighborPort ?? undefined,
    lldpNeighborDescr: input.lldpNeighborDescr ?? undefined,
    lldpNeighborMgmtIp: input.lldpNeighborMgmtIp ?? undefined,
    lagId: input.lagId ?? undefined,
    parentId: input.parentId ?? undefined,
    untaggedVlanId: input.untaggedVlanId ?? undefined,
  };
}
