import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { CircuitTerminationSide } from '@repo/database';
import { z } from 'zod';

export const CircuitTerminationPersistenceSchema = z.object({
  id: z.string(),
  termSide: z.nativeEnum(CircuitTerminationSide),
  portSpeed: z.number().nullable(),
  upstreamSpeed: z.number().nullable(),
  xconnectId: z.string().nullable(),
  description: z.string().nullable(),
  circuitId: z.string(),
  zoneId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateCircuitTerminationInput {
  termSide: CircuitTerminationSide;
  portSpeed?: number | null;
  upstreamSpeed?: number | null;
  xconnectId?: string | null;
  description?: string | null;
  circuitId: string;
  zoneId?: string | null;
}

export interface UpdateCircuitTerminationInput {
  termSide?: CircuitTerminationSide;
  portSpeed?: number | null;
  upstreamSpeed?: number | null;
  xconnectId?: string | null;
  description?: string | null;
  circuitId?: string;
  zoneId?: string | null;
}

export interface CircuitTerminationListQuery {
  circuitId?: string;
  zoneId?: string;
  search?: string;
}

export class CircuitTerminationRecord extends createActiveRecord(
  CircuitTerminationPersistenceSchema,
  'circuitTermination',
  {
    tenantField: 'circuit.organizationId',
    actions: { read: 'network:read', create: 'network:create', update: 'network:update', delete: 'network:delete' },
  },
) {
  static async list(query: CircuitTerminationListQuery): Promise<CircuitTerminationRecord[]> {
    this.requireAction('read');
    return this.findMany({
      where: {
        ...(query.circuitId ? { circuitId: query.circuitId } : {}),
        ...(query.zoneId ? { zoneId: query.zoneId } : {}),
        ...(query.search
          ? {
              OR: [
                { xconnectId: { contains: query.search, mode: 'insensitive' } },
                { description: { contains: query.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
    });
  }

  static async findByIdOrThrow(id: string): Promise<CircuitTerminationRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('Circuit termination not found');
    }
    return record;
  }

  static async create(input: CreateCircuitTerminationInput): Promise<CircuitTerminationRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    await assertParentCircuitReachable(input.circuitId, ctx.organizationId);
    if (input.zoneId != null) {
      await assertZoneReachable(input.zoneId, ctx.organizationId);
    }

    const delegate = this._unscopedDelegate();
    const created = await delegate.create({
      data: {
        termSide: input.termSide,
        portSpeed: input.portSpeed ?? undefined,
        upstreamSpeed: input.upstreamSpeed ?? undefined,
        xconnectId: input.xconnectId ?? undefined,
        description: input.description ?? undefined,
        circuitId: input.circuitId,
        zoneId: input.zoneId ?? undefined,
      },
    });
    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateCircuitTerminationInput): Promise<CircuitTerminationRecord> {
    this.requireAction('update');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    const existing = await this.findByIdOrThrow(id);

    if (input.circuitId !== undefined && input.circuitId !== existing.data.circuitId) {
      await assertParentCircuitReachable(input.circuitId, ctx.organizationId);
    }
    if (input.zoneId != null) {
      await assertZoneReachable(input.zoneId, ctx.organizationId);
    }

    existing.set(input);
    await existing.save();
    return existing;
  }

  static async deleteById(id: string): Promise<void> {
    this.requireAction('delete');
    const existing = await this.findByIdOrThrow(id);
    await existing.delete();
  }
}

async function assertParentCircuitReachable(circuitId: string, callerOrgId: string): Promise<void> {
  const circuit = await ActiveRecordRegistry.client.circuit.findUnique({
    where: { id: circuitId, organizationId: callerOrgId },
    select: { id: true },
  });
  if (!circuit) {
    throw new NotFoundException('Circuit not found');
  }
}

async function assertZoneReachable(zoneId: string, callerOrgId: string): Promise<void> {
  const zone = await ActiveRecordRegistry.client.zone.findUnique({
    where: { id: zoneId, organizationId: callerOrgId, deletedAt: null },
    select: { id: true },
  });
  if (!zone) {
    throw new NotFoundException('Zone not found');
  }
}
