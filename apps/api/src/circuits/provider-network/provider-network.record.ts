import { ConflictException, NotFoundException } from '@nestjs/common';
import { createActiveRecord } from '@repo/active-record';
import { z } from 'zod';
import { ProviderRecord } from '../provider/provider.record';

const ProviderNetworkPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  comments: z.string().nullable(),
  providerId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateProviderNetworkInput {
  name: string;
  description?: string | null;
  comments?: string | null;
  providerId: string;
}

export interface UpdateProviderNetworkInput {
  name?: string;
  description?: string | null;
  comments?: string | null;
}

export class ProviderNetworkRecord extends createActiveRecord(ProviderNetworkPersistenceSchema, 'providerNetwork') {
  static async list(filters: { providerId?: string; search?: string } = {}): Promise<ProviderNetworkRecord[]> {
    return this.findMany({
      where: {
        ...(filters.providerId ? { providerId: filters.providerId } : {}),
        ...(filters.search ? { name: { contains: filters.search, mode: 'insensitive' } } : {}),
      },
      orderBy: { name: 'asc' },
    });
  }

  static async findByIdOrThrow(id: string): Promise<ProviderNetworkRecord> {
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundException('Provider network not found');
    }
    return record;
  }

  static async createOne(input: CreateProviderNetworkInput): Promise<ProviderNetworkRecord> {
    const provider = await ProviderRecord.findById(input.providerId);
    if (!provider) {
      throw new NotFoundException('Provider not found');
    }

    await this.ensureNameUniquePerProvider(input.providerId, input.name);

    const delegate = this._delegate();
    const created = await delegate.create({
      data: {
        name: input.name,
        description: input.description ?? undefined,
        comments: input.comments ?? undefined,
        providerId: input.providerId,
      },
    });

    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateProviderNetworkInput): Promise<ProviderNetworkRecord> {
    const delegate = this._delegate();
    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Provider network not found');
    }

    if (input.name !== undefined) {
      await this.ensureNameUniquePerProvider(existing.providerId, input.name, id);
    }

    const updated = await delegate.update({ where: { id }, data: input });
    return new this(updated, 'persisted');
  }

  static async deleteById(id: string): Promise<void> {
    const delegate = this._delegate();
    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Provider network not found');
    }
    await delegate.delete({ where: { id } });
  }

  private static async ensureNameUniquePerProvider(providerId: string, name: string, excludeId?: string) {
    const delegate = this._delegate();
    const existing = await delegate.findFirst({
      where: { providerId, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException('Provider network name must be unique per provider');
    }
  }
}
