import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { z } from 'zod';

export const BgpPeerGroupPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  organizationId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateBgpPeerGroupInput {
  name: string;
  description?: string | null;
}

export interface UpdateBgpPeerGroupInput {
  name?: string;
  description?: string | null;
}

export class BgpPeerGroupRecord extends createActiveRecord(BgpPeerGroupPersistenceSchema, 'bgpPeerGroup', {
  tenantField: 'organizationId',
  actions: { read: 'network:read', create: 'network:create', update: 'network:update', delete: 'network:delete' },
}) {
  static async list(search?: string): Promise<BgpPeerGroupRecord[]> {
    this.requireAction('read');
    return this.findMany({
      where: {
        ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  static async findByIdOrThrow(id: string): Promise<BgpPeerGroupRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('BGP peer group not found');
    }
    return record;
  }

  static async create(input: CreateBgpPeerGroupInput): Promise<BgpPeerGroupRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    await this.ensureNameUnique(ctx.organizationId, input.name);

    const delegate = this._unscopedDelegate();
    const created = await delegate.create({
      data: {
        name: input.name,
        description: input.description ?? undefined,
        organizationId: ctx.organizationId,
      },
    });
    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateBgpPeerGroupInput): Promise<BgpPeerGroupRecord> {
    this.requireAction('update');
    const existing = await this.findByIdOrThrow(id);

    if (input.name !== undefined) {
      await this.ensureNameUnique(existing.data.organizationId, input.name, id);
    }

    const { organizationId: _ignoreOrgId, ...safeUpdates } = input as UpdateBgpPeerGroupInput & {
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

    const client = ActiveRecordRegistry.client;
    const sessionCount = await client.bgpSession.count({ where: { peerGroupId: id } });
    if (sessionCount > 0) {
      throw new ConflictException(
        `Cannot delete BGP peer group: it is in use by ${sessionCount} session${sessionCount === 1 ? '' : 's'}.`,
      );
    }

    const delegate = this._unscopedDelegate();
    await delegate.delete({ where: { id, organizationId: existing.data.organizationId } });
  }

  private static async ensureNameUnique(
    organizationId: string | null,
    name: string,
    excludeId?: string,
  ): Promise<void> {
    const delegate = this._unscopedDelegate();
    const existing = await delegate.findFirst({
      where: { organizationId, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException('BGP peer group name must be unique per organization');
    }
  }
}
