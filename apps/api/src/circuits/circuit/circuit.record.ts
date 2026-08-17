import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { CircuitStatus } from '@repo/database';
import { z } from 'zod';
import { CircuitTypeRecord } from '../circuit-type/circuit-type.record';
import { ProviderRecord } from '../provider/provider.record';

export const CircuitPersistenceSchema = z.object({
  id: z.string(),
  cid: z.string(),
  status: z.nativeEnum(CircuitStatus),
  installDate: z.date().nullable(),
  terminationDate: z.date().nullable(),
  commitRate: z.number().nullable(),
  description: z.string().nullable(),
  comments: z.string().nullable(),
  providerId: z.string(),
  circuitTypeId: z.string(),
  organizationId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateCircuitInput {
  cid: string;
  status?: CircuitStatus;
  installDate?: Date | null;
  terminationDate?: Date | null;
  commitRate?: number | null;
  description?: string | null;
  comments?: string | null;
  providerId: string;
  circuitTypeId: string;
}

export interface UpdateCircuitInput {
  cid?: string;
  status?: CircuitStatus;
  installDate?: Date | null;
  terminationDate?: Date | null;
  commitRate?: number | null;
  description?: string | null;
  comments?: string | null;
  providerId?: string;
  circuitTypeId?: string;
}

export interface CircuitListQuery {
  providerId?: string;
  circuitTypeId?: string;
  status?: CircuitStatus;
  search?: string;
}

export class CircuitRecord extends createActiveRecord(CircuitPersistenceSchema, 'circuit', {
  tenantField: 'organizationId',
  actions: { read: 'network:read', create: 'network:create', update: 'network:update', delete: 'network:delete' },
}) {
  static async list(query: CircuitListQuery): Promise<CircuitRecord[]> {
    this.requireAction('read');
    return this.findMany({
      where: {
        ...(query.providerId ? { providerId: query.providerId } : {}),
        ...(query.circuitTypeId ? { circuitTypeId: query.circuitTypeId } : {}),
        ...(query.status ? { status: query.status } : {}),
        ...(query.search ? { cid: { contains: query.search, mode: 'insensitive' } } : {}),
      },
      orderBy: { cid: 'asc' },
    });
  }

  static async findByIdOrThrow(id: string): Promise<CircuitRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('Circuit not found');
    }
    return record;
  }

  static async create(input: CreateCircuitInput): Promise<CircuitRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    await assertCircuitFkRefsExist(input.providerId, input.circuitTypeId);

    const delegate = this._unscopedDelegate();
    const created = await delegate.create({
      data: { ...buildCircuitCreateData(input), organizationId: ctx.organizationId },
    });
    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateCircuitInput): Promise<CircuitRecord> {
    this.requireAction('update');
    const existing = await this.findByIdOrThrow(id);
    const delegate = this._unscopedDelegate();

    const {
      providerId,
      circuitTypeId,
      organizationId: _ignoreOrgId,
      ...rest
    } = input as UpdateCircuitInput & { organizationId?: unknown };

    const updated = await delegate.update({
      where: { id, organizationId: existing.data.organizationId },
      data: {
        ...rest,
        ...(providerId !== undefined ? { providerId } : {}),
        ...(circuitTypeId !== undefined ? { circuitTypeId } : {}),
      },
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

export function buildCircuitCreateData(input: CreateCircuitInput) {
  return {
    cid: input.cid,
    status: input.status ?? undefined,
    installDate: input.installDate ?? undefined,
    terminationDate: input.terminationDate ?? undefined,
    commitRate: input.commitRate ?? undefined,
    description: input.description ?? undefined,
    comments: input.comments ?? undefined,
    providerId: input.providerId,
    circuitTypeId: input.circuitTypeId,
  };
}

export async function assertCircuitFkRefsExist(providerId: string, circuitTypeId: string): Promise<void> {
  const provider = await ProviderRecord.findById(providerId);
  if (!provider) {
    throw new NotFoundException('Provider not found');
  }
  const circuitType = await CircuitTypeRecord.findById(circuitTypeId);
  if (!circuitType) {
    throw new NotFoundException('Circuit type not found');
  }
}
