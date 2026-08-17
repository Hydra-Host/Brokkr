import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { z } from 'zod';

export const AsnPersistenceSchema = z.object({
  id: z.string(),
  asn: z.number(),
  description: z.string().nullable(),
  organizationId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateAsnInput {
  asn?: number;
  description?: string | null;
}

export interface UpdateAsnInput {
  asn?: number;
  description?: string | null;
}

export class AsnRecord extends createActiveRecord(AsnPersistenceSchema, 'asn', {
  tenantField: 'organizationId',
  actions: { read: 'network:read', create: 'network:create', update: 'network:update', delete: 'network:delete' },
}) {
  static async list(): Promise<AsnRecord[]> {
    this.requireAction('read');
    return this.findMany({ orderBy: { asn: 'asc' } });
  }

  static async findByIdOrThrow(id: string): Promise<AsnRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('ASN not found');
    }
    return record;
  }

  static async create(input: CreateAsnInput): Promise<AsnRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }

    const delegate = this._unscopedDelegate();
    const created = await delegate.create({
      data: {
        asn: input.asn,
        description: input.description ?? undefined,
        organizationId: ctx.organizationId,
      },
    });
    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateAsnInput): Promise<AsnRecord> {
    this.requireAction('update');
    const existing = await this.findByIdOrThrow(id);
    const delegate = this._unscopedDelegate();
    const updated = await delegate.update({
      where: { id, organizationId: existing.data.organizationId },
      data: { ...input },
    });
    return new this(updated, 'persisted');
  }

  static async deleteById(id: string): Promise<void> {
    this.requireAction('delete');
    const existing = await this.findByIdOrThrow(id);
    await assertNoSessionsReferenceAsn(id);

    const delegate = this._unscopedDelegate();
    await delegate.delete({ where: { id, organizationId: existing.data.organizationId } });
  }
}

export async function assertNoSessionsReferenceAsn(asnId: string): Promise<void> {
  const client = ActiveRecordRegistry.client;
  const sessionCount = await client.bgpSession.count({
    where: { OR: [{ localAsnId: asnId }, { remoteAsnId: asnId }] },
  });
  if (sessionCount > 0) {
    throw new ConflictException(
      `Cannot delete ASN: it is in use by ${sessionCount} BGP session${sessionCount === 1 ? '' : 's'}.`,
    );
  }
}
