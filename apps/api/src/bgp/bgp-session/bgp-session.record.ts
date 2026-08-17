import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { BgpSessionStatus } from '@repo/database';
import { z } from 'zod';

export const BgpSessionPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.nativeEnum(BgpSessionStatus),
  description: z.string().nullable(),
  deviceId: z.string().nullable(),
  localAsnId: z.string().nullable(),
  remoteAsnId: z.string().nullable(),
  localAddressId: z.string().nullable(),
  remoteAddressId: z.string().nullable(),
  peerGroupId: z.string().nullable(),
  prefixListInId: z.string().nullable(),
  prefixListOutId: z.string().nullable(),
  organizationId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateBgpSessionInput {
  name: string;
  status?: BgpSessionStatus;
  description?: string | null;
  deviceId?: string | null;
  localAsnId?: string | null;
  remoteAsnId?: string | null;
  localAddressId?: string | null;
  remoteAddressId?: string | null;
  peerGroupId?: string | null;
  prefixListInId?: string | null;
  prefixListOutId?: string | null;
}

export interface UpdateBgpSessionInput {
  name?: string;
  status?: BgpSessionStatus;
  description?: string | null;
  deviceId?: string | null;
  localAsnId?: string | null;
  remoteAsnId?: string | null;
  localAddressId?: string | null;
  remoteAddressId?: string | null;
  peerGroupId?: string | null;
  prefixListInId?: string | null;
  prefixListOutId?: string | null;
}

export interface BgpSessionListQuery {
  deviceId?: string;
  peerGroupId?: string;
  status?: BgpSessionStatus;
  search?: string;
}

export class BgpSessionRecord extends createActiveRecord(BgpSessionPersistenceSchema, 'bgpSession', {
  tenantField: 'organizationId',
  actions: { read: 'network:read', create: 'network:create', update: 'network:update', delete: 'network:delete' },
}) {
  static async list(query: BgpSessionListQuery): Promise<BgpSessionRecord[]> {
    this.requireAction('read');
    return this.findMany({
      where: {
        ...(query.deviceId ? { deviceId: query.deviceId } : {}),
        ...(query.peerGroupId ? { peerGroupId: query.peerGroupId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.search ? { name: { contains: query.search, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  static async findByIdOrThrow(id: string): Promise<BgpSessionRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('BGP session not found');
    }
    return record;
  }

  static async create(input: CreateBgpSessionInput): Promise<BgpSessionRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    await assertSessionFkRefsAreReachable(input, ctx.organizationId);

    const delegate = this._unscopedDelegate();
    const created = await delegate.create({
      data: { ...buildBgpSessionCreateData(input), organizationId: ctx.organizationId },
    });
    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateBgpSessionInput): Promise<BgpSessionRecord> {
    this.requireAction('update');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    const existing = await this.findByIdOrThrow(id);
    await assertSessionFkRefsAreReachable(input, ctx.organizationId);

    const { organizationId: _ignoreOrgId, ...safeUpdates } = input as UpdateBgpSessionInput & {
      organizationId?: unknown;
    };

    const delegate = this._unscopedDelegate();
    const updated = await delegate.update({
      where: { id, organizationId: existing.data.organizationId },
      data: { ...safeUpdates },
    });
    return new this(updated, 'persisted');
  }

  static async deleteById(id: string): Promise<void> {
    this.requireAction('delete');
    const existing = await this.findByIdOrThrow(id);
    const delegate = this._unscopedDelegate();
    await delegate.delete({ where: { id, organizationId: existing.data.organizationId } });
  }
}

async function assertSessionFkRefsAreReachable(
  input: CreateBgpSessionInput | UpdateBgpSessionInput,
  callerOrgId: string,
): Promise<void> {
  const client = ActiveRecordRegistry.client;
  const sameOrg = { organizationId: callerOrgId };

  if (input.deviceId !== undefined && input.deviceId !== null) {
    const ok = await client.device.findUnique({
      where: { id: input.deviceId, supplierId: callerOrgId, deletedAt: null },
      select: { id: true },
    });
    if (!ok) throw new NotFoundException('Device not found');
  }
  if (input.peerGroupId !== undefined && input.peerGroupId !== null) {
    const ok = await client.bgpPeerGroup.findUnique({
      where: { id: input.peerGroupId, ...sameOrg },
      select: { id: true },
    });
    if (!ok) throw new NotFoundException('BGP peer group not found');
  }
  if (input.prefixListInId !== undefined && input.prefixListInId !== null) {
    const ok = await client.prefixList.findUnique({
      where: { id: input.prefixListInId, ...sameOrg },
      select: { id: true },
    });
    if (!ok) throw new NotFoundException('Prefix list not found');
  }
  if (input.prefixListOutId !== undefined && input.prefixListOutId !== null) {
    const ok = await client.prefixList.findUnique({
      where: { id: input.prefixListOutId, ...sameOrg },
      select: { id: true },
    });
    if (!ok) throw new NotFoundException('Prefix list not found');
  }
  if (input.localAsnId !== undefined && input.localAsnId !== null) {
    const ok = await client.asn.findUnique({
      where: { id: input.localAsnId, ...sameOrg },
      select: { id: true },
    });
    if (!ok) throw new NotFoundException('ASN not found');
  }
  if (input.remoteAsnId !== undefined && input.remoteAsnId !== null) {
    const ok = await client.asn.findUnique({
      where: { id: input.remoteAsnId, ...sameOrg },
      select: { id: true },
    });
    if (!ok) throw new NotFoundException('ASN not found');
  }
  if (input.localAddressId !== undefined && input.localAddressId !== null) {
    const ok = await client.ipAddress.findUnique({
      where: { id: input.localAddressId, ...sameOrg },
      select: { id: true },
    });
    if (!ok) throw new NotFoundException('IP address not found');
  }
  if (input.remoteAddressId !== undefined && input.remoteAddressId !== null) {
    const ok = await client.ipAddress.findUnique({
      where: { id: input.remoteAddressId, ...sameOrg },
      select: { id: true },
    });
    if (!ok) throw new NotFoundException('IP address not found');
  }
}

export function buildBgpSessionCreateData(input: CreateBgpSessionInput) {
  return {
    name: input.name,
    status: input.status ?? BgpSessionStatus.ACTIVE,
    description: input.description ?? undefined,
    deviceId: input.deviceId ?? undefined,
    localAsnId: input.localAsnId ?? undefined,
    remoteAsnId: input.remoteAsnId ?? undefined,
    localAddressId: input.localAddressId ?? undefined,
    remoteAddressId: input.remoteAddressId ?? undefined,
    peerGroupId: input.peerGroupId ?? undefined,
    prefixListInId: input.prefixListInId ?? undefined,
    prefixListOutId: input.prefixListOutId ?? undefined,
  };
}
