import { ConflictException, NotFoundException } from '@nestjs/common';
import { createActiveRecord } from '@repo/active-record';
import { z } from 'zod';

const RackRoleP = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  color: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateRackRoleInput {
  name: string;
  slug: string;
  color?: string | null;
  description?: string | null;
}

export interface UpdateRackRoleInput {
  name?: string;
  slug?: string;
  color?: string | null;
  description?: string | null;
}

export class RackRoleRecord extends createActiveRecord(RackRoleP, 'dcimRackRole', {
  actions: { read: 'dcim:read' },
}) {
  static async list(search?: string): Promise<RackRoleRecord[]> {
    this.requireAction('read');
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

  static async findByIdOrThrow(id: string): Promise<RackRoleRecord> {
    this.requireAction('read');
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundException('Rack role not found');
    }
    return record;
  }

  static async createRole(input: CreateRackRoleInput): Promise<RackRoleRecord> {
    await this.ensureSlugUnique(input.slug);

    const delegate = this._delegate();
    const created = await delegate.create({
      data: {
        name: input.name,
        slug: input.slug,
        color: input.color ?? undefined,
        description: input.description ?? undefined,
      },
    });

    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateRackRoleInput): Promise<RackRoleRecord> {
    const delegate = this._delegate();
    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Rack role not found');
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
      throw new NotFoundException('Rack role not found');
    }
    await delegate.delete({ where: { id } });
  }

  private static async ensureSlugUnique(slug: string, excludeId?: string) {
    const delegate = this._delegate();
    const existing = await delegate.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException('Rack role slug must be unique');
    }
  }
}
