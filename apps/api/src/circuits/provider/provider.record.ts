import { ConflictException, NotFoundException } from '@nestjs/common';
import { createActiveRecord } from '@repo/active-record';
import { z } from 'zod';

const ProviderPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  comments: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateProviderInput {
  name: string;
  slug: string;
  description?: string | null;
  comments?: string | null;
}

export interface UpdateProviderInput {
  name?: string;
  slug?: string;
  description?: string | null;
  comments?: string | null;
}

export class ProviderRecord extends createActiveRecord(ProviderPersistenceSchema, 'provider') {
  static async list(search?: string): Promise<ProviderRecord[]> {
    return this.findMany({
      where: search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : undefined,
      orderBy: { name: 'asc' },
    });
  }

  static async findByIdOrThrow(id: string): Promise<ProviderRecord> {
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundException('Provider not found');
    }
    return record;
  }

  static async createOne(input: CreateProviderInput): Promise<ProviderRecord> {
    await this.ensureSlugUnique(input.slug);

    const delegate = this._delegate();
    const created = await delegate.create({
      data: {
        name: input.name,
        slug: input.slug,
        description: input.description ?? undefined,
        comments: input.comments ?? undefined,
      },
    });

    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateProviderInput): Promise<ProviderRecord> {
    const delegate = this._delegate();
    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Provider not found');
    }

    if (input.slug !== undefined) {
      await this.ensureSlugUnique(input.slug, id);
    }

    const updated = await delegate.update({ where: { id }, data: input });
    return new this(updated, 'persisted');
  }

  static async deleteById(id: string): Promise<void> {
    const delegate = this._delegate();
    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Provider not found');
    }
    await delegate.delete({ where: { id } });
  }

  private static async ensureSlugUnique(slug: string, excludeId?: string) {
    const delegate = this._delegate();
    const existing = await delegate.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException('Provider slug must be unique');
    }
  }
}
