import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { RackFace, RackRole, RackStatus } from '@repo/database';
import type { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { z } from 'zod';
import { rackPaginationConfig } from './rack.pagination';

const MAX_RACK_UNITS = 1000;

export const RackPersistenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  role: z.string().nullable(),
  heightU: z.number(),
  startingUnit: z.number(),
  description: z.string().nullable(),
  serial: z.string().nullable(),
  assetTag: z.string().nullable(),
  zoneId: z.string(),
  organizationId: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export interface CreateRackInput {
  name: string;
  status?: RackStatus;
  role?: RackRole | null;
  heightU?: number;
  startingUnit?: number;
  description?: string | null;
  serial?: string | null;
  assetTag?: string | null;
  zoneId: string;
}

export interface UpdateRackInput {
  name?: string;
  status?: RackStatus;
  role?: RackRole | null;
  heightU?: number;
  startingUnit?: number;
  description?: string | null;
  serial?: string | null;
  assetTag?: string | null;
}

export interface RackElevationUnit {
  unit: number;
  face: RackFace;
  occupied: boolean;
  device: { id: string; name: string; heightU: number; position: number } | null;
}

export class RackRecord extends createActiveRecord(RackPersistenceSchema, 'rack', {
  tenantField: 'organizationId',
  actions: { read: 'dcim:read', create: 'dcim:create', update: 'dcim:update', delete: 'dcim:delete' },
}) {
  static async listByZone(zoneId: string): Promise<RackRecord[]> {
    this.requireAction('read');
    return this.findMany({
      where: { zoneId },
      orderBy: { name: 'asc' },
    });
  }

  static async listPaginated(query: PaginationQuery): Promise<PaginatedResult<RackRecord>> {
    this.requireAction('read');
    const result = await paginateQuery<z.infer<typeof RackPersistenceSchema>>(
      this._delegate(),
      query,
      rackPaginationConfig,
    );
    return {
      ...result,
      data: result.data.map((row) => this.fromRow(row)),
    };
  }

  static async findByIdOrThrow(id: string): Promise<RackRecord> {
    this.requireAction('read');
    const record = await this.findOne({ where: { id } });
    if (!record) {
      throw new NotFoundException('Rack not found');
    }
    return record;
  }

  static async create(input: CreateRackInput): Promise<RackRecord> {
    this.requireAction('create');
    const ctx = ActiveRecordRegistry.context;
    if (!ctx) {
      throw new BadRequestException('No active organization in request context');
    }
    await assertParentZoneReachable(input.zoneId, ctx.organizationId);

    await this.ensureNameUnique(input.zoneId, input.name);
    const heightU = input.heightU ?? 42;
    const startingUnit = input.startingUnit ?? 1;
    this.validateHeightU(heightU);
    this.validateStartingUnit(startingUnit);

    const delegate = this._unscopedDelegate();
    const created = await delegate.create({
      data: {
        name: input.name,
        status: input.status ?? RackStatus.ACTIVE,
        role: input.role ?? undefined,
        heightU,
        startingUnit,
        description: input.description ?? undefined,
        serial: input.serial ?? undefined,
        assetTag: input.assetTag ?? undefined,
        zoneId: input.zoneId,
        organizationId: ctx.organizationId,
      },
    });

    return new this(created, 'persisted');
  }

  static async updateById(id: string, input: UpdateRackInput): Promise<RackRecord> {
    this.requireAction('update');
    const existing = await this.findByIdOrThrow(id);

    if (input.name !== undefined) {
      await this.ensureNameUnique(existing.data.zoneId, input.name, id);
    }

    const effectiveHeightU = input.heightU !== undefined ? input.heightU : existing.data.heightU;
    const effectiveStartingUnit = input.startingUnit !== undefined ? input.startingUnit : existing.data.startingUnit;
    this.validateHeightU(effectiveHeightU);
    this.validateStartingUnit(effectiveStartingUnit);

    if (input.heightU !== undefined && input.heightU < existing.data.heightU) {
      await this.ensureHeightSufficient(id, input.heightU, effectiveStartingUnit);
    }

    const { organizationId: _ignoreOrgId, ...safeUpdates } = input as UpdateRackInput & {
      organizationId?: unknown;
    };

    // Pin WHERE to the record's known org: TOCTOU defense against concurrent admin reassignment.
    const delegate = this._unscopedDelegate();
    const updated = await delegate.update({
      where: { id, organizationId: existing.data.organizationId },
      data: safeUpdates,
    });
    return new this(updated, 'persisted');
  }

  static async deleteById(id: string): Promise<void> {
    this.requireAction('delete');
    const existing = await this.findByIdOrThrow(id);
    // Same TOCTOU defense-in-depth as updateById.
    const delegate = this._unscopedDelegate();
    await delegate.delete({ where: { id, organizationId: existing.data.organizationId } });
  }

  static async getElevation(rackId: string, face?: RackFace | string): Promise<RackElevationUnit[]> {
    const rack = await this.findByIdOrThrow(rackId);

    const client = ActiveRecordRegistry.client;
    const assignments = (await client.deviceRackAssignment.findMany({
      where: {
        rackId,
        ...(face ? { face: face as RackFace } : {}),
      },
      include: { device: { select: { id: true, name: true } } },
    })) as Array<{
      face: RackFace;
      heightU: number;
      position: unknown;
      device: { id: string; name: string };
    }>;

    const units: RackElevationUnit[] = [];
    const faces: RackFace[] = face ? [face as RackFace] : [RackFace.FRONT, RackFace.REAR];

    for (const f of faces) {
      for (let u = rack.data.startingUnit; u < rack.data.startingUnit + rack.data.heightU; u++) {
        const assignment = assignments.find(
          (a) => a.face === f && Number(a.position) <= u && Number(a.position) + a.heightU - 1 >= u,
        );

        units.push({
          unit: u,
          face: f,
          occupied: !!assignment,
          device: assignment
            ? {
                id: assignment.device.id,
                name: assignment.device.name,
                heightU: assignment.heightU,
                position: Number(assignment.position),
              }
            : null,
        });
      }
    }

    return units;
  }

  static validateHeightU(heightU: number) {
    if (heightU < 1) {
      throw new BadRequestException('Rack height must be at least 1U');
    }
    if (heightU > MAX_RACK_UNITS) {
      throw new BadRequestException(`Rack height must be at most ${MAX_RACK_UNITS}U`);
    }
  }

  static validateStartingUnit(startingUnit: number) {
    if (startingUnit < 1) {
      throw new BadRequestException('Starting unit must be at least 1');
    }
    if (startingUnit > MAX_RACK_UNITS) {
      throw new BadRequestException(`Starting unit must be at most ${MAX_RACK_UNITS}`);
    }
  }

  static async ensureNameUnique(zoneId: string, name: string, excludeId?: string) {
    const delegate = this._unscopedDelegate();
    const existing = await delegate.findFirst({
      where: { zoneId, name, ...(excludeId ? { id: { not: excludeId } } : {}) },
    });
    if (existing) {
      throw new ConflictException('Rack name must be unique per zone');
    }
  }

  static async ensureHeightSufficient(rackId: string, newHeightU: number, startingUnit: number) {
    const client = ActiveRecordRegistry.client;
    const maxUnit = startingUnit + newHeightU - 1;
    const assignments = (await client.deviceRackAssignment.findMany({
      where: { rackId },
      select: { position: true, heightU: true },
    })) as Array<{ position: unknown; heightU: number }>;

    for (const assignment of assignments) {
      const topUnit = Number(assignment.position) + assignment.heightU - 1;
      if (topUnit > maxUnit) {
        throw new BadRequestException(
          `Cannot reduce rack height: device at position ${String(assignment.position)} extends to U${topUnit}, but new max is U${maxUnit}`,
        );
      }
    }
  }
}

export async function assertParentZoneReachable(zoneId: string, callerOrgId: string): Promise<void> {
  const zone = await ActiveRecordRegistry.client.zone.findUnique({
    where: { id: zoneId, organizationId: callerOrgId },
    select: { id: true },
  });
  if (!zone) {
    throw new NotFoundException('Zone not found');
  }
}
