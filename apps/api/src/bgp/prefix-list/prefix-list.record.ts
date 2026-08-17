import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { z } from 'zod';

export const PrefixListPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  family: z.string().nullable(),
  organizationId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreatePrefixListInput {
  name: string;
  description?: string | null;
  family?: string | null;
}

export interface UpdatePrefixListInput {
  name?: string;
  description?: string | null;
  family?: string | null;
}

export class PrefixListRecord extends createActiveRecord(PrefixListPersistenceSchema, 'prefixList', {
  tenantField: 'organizationId',
  actions: { read: 'network:read', create: 'network:create', update: 'network:update', delete: 'network:delete' },
}) {
  static async list(filters: { family?: string; search?: string } = {}): Promise<PrefixListRecord[]> {
    this.requireAction('read');
    return this.findMany({
      where: {
        ...(filters.family ? { family: { equals: filters.family, mode: 'insensitive' } } : {}),
        ...(filters.search ? { name: { contains: filters.search, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  static async findByIdOrThrow(id: string): Promise<PrefixListRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('Prefix list not found');
    }
    return record;
  }

  static async create(input: CreatePrefixListInput): Promise<PrefixListRecord> {
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
        family: input.family ?? undefined,
        organizationId: ctx.organizationId,
      },
    });
    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdatePrefixListInput): Promise<PrefixListRecord> {
    this.requireAction('update');
    const existing = await this.findByIdOrThrow(id);

    if (input.name !== undefined) {
      await this.ensureNameUnique(existing.data.organizationId, input.name, id);
    }

    const { organizationId: _ignoreOrgId, ...safeUpdates } = input as UpdatePrefixListInput & {
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
    const sessionCount = await client.bgpSession.count({
      where: { OR: [{ prefixListInId: id }, { prefixListOutId: id }] },
    });
    if (sessionCount > 0) {
      throw new ConflictException(
        `Cannot delete prefix list: it is in use by ${sessionCount} BGP session${sessionCount === 1 ? '' : 's'}.`,
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
      throw new ConflictException('Prefix list name must be unique per organization');
    }
  }
}
