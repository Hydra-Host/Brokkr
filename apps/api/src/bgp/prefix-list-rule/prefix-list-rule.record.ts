import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { Prisma } from '@repo/database';
import { z } from 'zod';

export const PrefixListRulePersistenceSchema = z.object({
  id: z.string(),
  action: z.string(),
  prefix: z.string().nullable(),
  ge: z.number().nullable(),
  le: z.number().nullable(),
  sequence: z.number(),
  prefixListId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreatePrefixListRuleInput {
  action: string;
  prefix?: string | null;
  ge?: number | null;
  le?: number | null;
  sequence: number;
  prefixListId: string;
}

export interface UpdatePrefixListRuleInput {
  action?: string;
  prefix?: string | null;
  ge?: number | null;
  le?: number | null;
  sequence?: number;
  prefixListId?: string;
}

export interface PrefixListRuleListQuery {
  prefixListId?: string;
  search?: string;
}

export class PrefixListRuleRecord extends createActiveRecord(PrefixListRulePersistenceSchema, 'prefixListRule', {
  tenantField: 'prefixList.organizationId',
  actions: { read: 'network:read', create: 'network:create', update: 'network:update', delete: 'network:delete' },
}) {
  static async list(query: PrefixListRuleListQuery): Promise<PrefixListRuleRecord[]> {
    this.requireAction('read');
    return this.findMany({
      where: {
        ...(query.prefixListId ? { prefixListId: query.prefixListId } : {}),
        ...(query.search
          ? {
              OR: [
                { prefix: { contains: query.search, mode: 'insensitive' } },
                { action: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: { sequence: 'asc' },
    });
  }

  static async findByIdOrThrow(id: string): Promise<PrefixListRuleRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('Prefix list rule not found');
    }
    return record;
  }

  static async create(input: CreatePrefixListRuleInput): Promise<PrefixListRuleRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    await assertParentPrefixListReachable(input.prefixListId, ctx.organizationId);
    await this.ensureSequenceUnique(input.prefixListId, input.sequence);

    const delegate = this._unscopedDelegate();
    try {
      const created = await delegate.create({
        data: {
          action: input.action,
          prefix: input.prefix ?? undefined,
          ge: input.ge ?? undefined,
          le: input.le ?? undefined,
          sequence: input.sequence,
          prefixListId: input.prefixListId,
        },
      });
      return new this(created, 'persisted');
    } catch (error) {
      this.rethrowSequenceConflict(error);
    }
  }

  static async updateById(id: string, input: UpdatePrefixListRuleInput): Promise<PrefixListRuleRecord> {
    this.requireAction('update');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    const existing = await this.findByIdOrThrow(id);

    if (input.prefixListId !== undefined && input.prefixListId !== existing.data.prefixListId) {
      await assertParentPrefixListReachable(input.prefixListId, ctx.organizationId);
    }

    if (input.sequence !== undefined && input.sequence !== existing.data.sequence) {
      await this.ensureSequenceUnique(input.prefixListId ?? existing.data.prefixListId, input.sequence, id);
    }

    const { prefixListId, ...rest } = input;
    const delegate = this._unscopedDelegate();
    try {
      const updated = await delegate.update({
        where: { id },
        data: {
          ...rest,
          ...(prefixListId !== undefined ? { prefixListId } : {}),
        },
      });
      return new this(updated, 'persisted');
    } catch (error) {
      this.rethrowSequenceConflict(error);
    }
  }

  static async deleteById(id: string): Promise<void> {
    this.requireAction('delete');
    await this.findByIdOrThrow(id);
    const delegate = this._unscopedDelegate();
    await delegate.delete({ where: { id } });
  }

  private static async ensureSequenceUnique(prefixListId: string, sequence: number, excludeId?: string): Promise<void> {
    const existing = await this._unscopedDelegate().findFirst({
      where: {
        prefixListId,
        sequence,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException('Rule sequence must be unique within the prefix list');
    }
  }

  private static rethrowSequenceConflict(error: unknown): never {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new ConflictException('Rule sequence must be unique within the prefix list');
    }
    throw error;
  }
}

async function assertParentPrefixListReachable(prefixListId: string, callerOrgId: string): Promise<void> {
  const client = ActiveRecordRegistry.client;
  const parent = await client.prefixList.findUnique({
    where: { id: prefixListId, organizationId: callerOrgId },
    select: { id: true },
  });
  if (!parent) {
    throw new NotFoundException('Prefix list not found');
  }
}
