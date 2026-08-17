import { ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { z } from 'zod';

const CircuitTypePersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  color: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateCircuitTypeInput {
  name: string;
  slug: string;
  color?: string | null;
  description?: string | null;
}

export interface UpdateCircuitTypeInput {
  name?: string;
  slug?: string;
  color?: string | null;
  description?: string | null;
}

export class CircuitTypeRecord extends createActiveRecord(CircuitTypePersistenceSchema, 'circuitType', {
  actions: { read: 'network:read' },
}) {
  static async list(search?: string): Promise<CircuitTypeRecord[]> {
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

  static async findByIdOrThrow(id: string): Promise<CircuitTypeRecord> {
    this.requireAction('read');
    const record = await this.findById(id);
    if (!record) {
      throw new NotFoundException('Circuit type not found');
    }
    return record;
  }

  static async createOne(input: CreateCircuitTypeInput): Promise<CircuitTypeRecord> {
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

  static async updateById(id: string, input: UpdateCircuitTypeInput): Promise<CircuitTypeRecord> {
    const delegate = this._delegate();
    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Circuit type not found');
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
      throw new NotFoundException('Circuit type not found');
    }

    const client = ActiveRecordRegistry.client;
    const circuitCount = await client.circuit.count({ where: { circuitTypeId: id } });
    if (circuitCount > 0) {
      throw new ConflictException(
        `Cannot delete circuit type: it is in use by ${circuitCount} circuit${circuitCount === 1 ? '' : 's'}.`,
      );
    }

    await delegate.delete({ where: { id } });
  }

  private static async ensureSlugUnique(slug: string, excludeId?: string) {
    const delegate = this._delegate();
    const existing = await delegate.findFirst({
      where: { slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException('Circuit type slug must be unique');
    }
  }
}
