import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { CableLengthUnit, CableSide, CableStatus, CableTerminationType, CableType, Prisma } from '@repo/database';
import type { PaginatedResult, PaginationQuery } from '@repo/database/pagination';
import { buildPaginatedResponse, paginateQuery } from '@repo/database/pagination';
import { z } from 'zod';
import { listOwnedCablePage } from './cable-ownership.query';
import { cablePaginationConfig } from './cable.pagination';

const CablePersistenceSchema = z.object({
  id: z.string(),
  type: z.string().nullable(),
  status: z.string(),
  label: z.string().nullable(),
  color: z.string().nullable(),
  length: z.unknown().nullable(),
  lengthUnit: z.string().nullable(),
  description: z.string().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const COMPATIBLE_TERMINATION_TYPES: Record<CableTerminationType, CableTerminationType[]> = {
  [CableTerminationType.CONSOLE_PORT]: [
    CableTerminationType.CONSOLE_SERVER_PORT,
    CableTerminationType.FRONT_PORT,
    CableTerminationType.REAR_PORT,
  ],
  [CableTerminationType.CONSOLE_SERVER_PORT]: [
    CableTerminationType.CONSOLE_PORT,
    CableTerminationType.FRONT_PORT,
    CableTerminationType.REAR_PORT,
  ],
  [CableTerminationType.INTERFACE]: [
    CableTerminationType.INTERFACE,
    CableTerminationType.FRONT_PORT,
    CableTerminationType.REAR_PORT,
  ],
  [CableTerminationType.FRONT_PORT]: [
    CableTerminationType.CONSOLE_PORT,
    CableTerminationType.CONSOLE_SERVER_PORT,
    CableTerminationType.INTERFACE,
    CableTerminationType.FRONT_PORT,
    CableTerminationType.REAR_PORT,
  ],
  [CableTerminationType.POWER_OUTLET]: [CableTerminationType.POWER_PORT],
  [CableTerminationType.POWER_PORT]: [CableTerminationType.POWER_OUTLET],
  [CableTerminationType.REAR_PORT]: [
    CableTerminationType.CONSOLE_PORT,
    CableTerminationType.CONSOLE_SERVER_PORT,
    CableTerminationType.INTERFACE,
    CableTerminationType.FRONT_PORT,
    CableTerminationType.REAR_PORT,
  ],
};

export interface CableTerminationInput {
  cableSide: CableSide;
  terminationType: CableTerminationType;
  terminationId: string;
}

export interface CreateCableInput {
  type?: CableType | null;
  status?: CableStatus;
  label?: string | null;
  color?: string | null;
  length?: Prisma.Decimal | number | null;
  lengthUnit?: CableLengthUnit | null;
  description?: string | null;
  terminations: CableTerminationInput[];
}

export interface UpdateCableInput {
  type?: CableType | null;
  status?: CableStatus;
  label?: string | null;
  color?: string | null;
  length?: Prisma.Decimal | number | null;
  lengthUnit?: CableLengthUnit | null;
  description?: string | null;
}

const ALL_TERMINATION_TYPES: CableTerminationType[] = [
  CableTerminationType.INTERFACE,
  CableTerminationType.CONSOLE_PORT,
  CableTerminationType.CONSOLE_SERVER_PORT,
  CableTerminationType.POWER_PORT,
  CableTerminationType.POWER_OUTLET,
  CableTerminationType.FRONT_PORT,
  CableTerminationType.REAR_PORT,
];

async function findOwnedPortIds(
  client: typeof ActiveRecordRegistry.client,
  terminationType: CableTerminationType,
  filter: { ids: string[]; supplierId: string },
): Promise<string[]> {
  const where = { id: { in: filter.ids }, device: { supplierId: filter.supplierId } };
  switch (terminationType) {
    case CableTerminationType.INTERFACE: {
      const rows = await client.interface.findMany({ where, select: { id: true } });
      return rows.map((r) => r.id);
    }
    case CableTerminationType.CONSOLE_PORT: {
      const rows = await client.consolePort.findMany({ where, select: { id: true } });
      return rows.map((r) => r.id);
    }
    case CableTerminationType.CONSOLE_SERVER_PORT: {
      const rows = await client.consoleServerPort.findMany({ where, select: { id: true } });
      return rows.map((r) => r.id);
    }
    case CableTerminationType.POWER_PORT: {
      const rows = await client.powerPort.findMany({ where, select: { id: true } });
      return rows.map((r) => r.id);
    }
    case CableTerminationType.POWER_OUTLET: {
      const rows = await client.powerOutlet.findMany({ where, select: { id: true } });
      return rows.map((r) => r.id);
    }
    case CableTerminationType.FRONT_PORT: {
      const rows = await client.frontPort.findMany({ where, select: { id: true } });
      return rows.map((r) => r.id);
    }
    case CableTerminationType.REAR_PORT: {
      const rows = await client.rearPort.findMany({ where, select: { id: true } });
      return rows.map((r) => r.id);
    }
  }
}

function groupIdsByType(
  terminations: Array<{ terminationType: CableTerminationType; terminationId: string }>,
): Record<CableTerminationType, string[]> {
  const out: Record<CableTerminationType, string[]> = {
    [CableTerminationType.INTERFACE]: [],
    [CableTerminationType.CONSOLE_PORT]: [],
    [CableTerminationType.CONSOLE_SERVER_PORT]: [],
    [CableTerminationType.POWER_PORT]: [],
    [CableTerminationType.POWER_OUTLET]: [],
    [CableTerminationType.FRONT_PORT]: [],
    [CableTerminationType.REAR_PORT]: [],
  };
  for (const t of terminations) {
    out[t.terminationType].push(t.terminationId);
  }
  return out;
}

// Cable tenancy derives from terminations (a supplier owns a cable iff every termination's port sits on its devices); `supplierId` undefined = admin scope — the caller must be admin-protected.
export class CableRecord extends createActiveRecord(CablePersistenceSchema, 'cable', {
  actions: { read: 'dcim:read', create: 'dcim:create', update: 'dcim:update', delete: 'dcim:delete' },
}) {
  static async listPaginated(query: PaginationQuery, supplierId?: string): Promise<PaginatedResult<CableRecord>> {
    this.requireAction('read');
    if (!supplierId) {
      const result = await paginateQuery<z.infer<typeof CablePersistenceSchema>>(
        this._delegate(),
        query,
        cablePaginationConfig,
      );
      return {
        ...result,
        data: result.data.map((row) => this.fromRow(row)),
      };
    }
    const { ids, totalItems } = await listOwnedCablePage(
      ActiveRecordRegistry.client,
      supplierId,
      query,
      cablePaginationConfig,
    );
    const records = await this.findMany({ where: { id: { in: ids } }, include: { terminations: true } });
    const byId = new Map<string, CableRecord>(records.map((record) => [record.data.id, record]));
    const ordered = ids.map((id) => byId.get(id)).filter((record) => record !== undefined);
    return buildPaginatedResponse(ordered, totalItems, query, cablePaginationConfig.defaultPageSize);
  }

  static async findByIdOrThrow(id: string, supplierId?: string): Promise<CableRecord> {
    this.requireAction('read');
    const record = await this.findOne({
      where: { id },
      include: { terminations: true },
    });
    if (!record) {
      throw new NotFoundException('Cable not found');
    }
    if (supplierId) {
      const terminations = await this.loadTerminations(id);
      const ok = await this.terminationsOwnedBy(terminations, supplierId);
      if (!ok) {
        // 404 (not 403) so we don't disclose which IDs map to foreign cables.
        throw new NotFoundException('Cable not found');
      }
    }
    return record;
  }

  static async createWithTerminations(input: CreateCableInput, supplierId?: string): Promise<CableRecord> {
    this.requireAction('create');
    this.validateLengthUnit(input.length, input.lengthUnit);
    this.validateTerminations(input.terminations);

    if (supplierId) {
      const ok = await this.terminationsOwnedBy(input.terminations, supplierId);
      if (!ok) {
        throw new ForbiddenException('One or more terminations reference ports outside your organization');
      }
    }

    await this.assertTerminationsFree(input.terminations);

    const delegate = this._delegate();
    try {
      const created = await delegate.create({
        data: {
          type: input.type ?? undefined,
          status: input.status ?? CableStatus.CONNECTED,
          label: input.label ?? undefined,
          color: input.color ?? undefined,
          length: input.length ?? undefined,
          lengthUnit: input.lengthUnit ?? undefined,
          description: input.description ?? undefined,
          terminations: {
            create: input.terminations.map((t) => ({
              cableSide: t.cableSide,
              terminationType: t.terminationType,
              terminationId: t.terminationId,
            })),
          },
        },
        include: { terminations: true },
      });

      return new this(created, 'persisted');
    } catch (error) {
      // Race backstop: concurrent create can pass assertTerminationsFree and hit the unique index → 409.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('One or more ports are already connected to another cable');
      }
      throw error;
    }
  }

  // Clean-409 pre-check (a port hosts at most one cable end); the DB unique index is the race backstop.
  private static async assertTerminationsFree(terminations: CableTerminationInput[]): Promise<void> {
    const byType = groupIdsByType(terminations);
    const orConditions: Prisma.CableTerminationWhereInput[] = ALL_TERMINATION_TYPES.filter(
      (t) => byType[t].length > 0,
    ).map((t) => ({ terminationType: t, terminationId: { in: byType[t] } }));

    const occupied = await ActiveRecordRegistry.client.cableTermination.findFirst({
      where: { OR: orConditions },
      select: { terminationType: true, terminationId: true },
    });
    if (occupied) {
      throw new ConflictException(
        `Port ${occupied.terminationType}:${occupied.terminationId} is already connected to another cable`,
      );
    }
  }

  static async updateById(id: string, input: UpdateCableInput, supplierId?: string): Promise<CableRecord> {
    this.requireAction('update');
    const existing = await this.findByIdOrThrow(id, supplierId);

    const effectiveLength = input.length !== undefined ? input.length : existing.data.length;
    const effectiveLengthUnit = input.lengthUnit !== undefined ? input.lengthUnit : existing.data.lengthUnit;
    this.validateLengthUnit(effectiveLength, effectiveLengthUnit);

    const delegate = this._delegate();
    const updated = await delegate.update({
      where: { id },
      data: input,
      include: { terminations: true },
    });

    return new this(updated, 'persisted');
  }

  static async deleteById(id: string, supplierId?: string): Promise<void> {
    this.requireAction('delete');
    await this.findByIdOrThrow(id, supplierId);
    await this._delegate().delete({ where: { id } });
  }

  private static async loadTerminations(
    cableId: string,
  ): Promise<Array<{ terminationType: CableTerminationType; terminationId: string }>> {
    const client = ActiveRecordRegistry.client;
    return client.cableTermination.findMany({
      where: { cableId },
      select: { terminationType: true, terminationId: true },
    });
  }

  private static async terminationsOwnedBy(
    terminations: Array<{ terminationType: CableTerminationType; terminationId: string }>,
    supplierId: string,
  ): Promise<boolean> {
    if (terminations.length === 0) {
      // Empty cable → unowned, fail closed.
      return false;
    }
    const byType = groupIdsByType(terminations);
    const client = ActiveRecordRegistry.client;

    const checks = ALL_TERMINATION_TYPES.filter((t) => byType[t].length > 0).map(async (t) => {
      const owned = await findOwnedPortIds(client, t, { ids: byType[t], supplierId });
      return { count: owned.length, expected: byType[t].length };
    });

    const results = await Promise.all(checks);
    return results.every((r) => r.count === r.expected);
  }

  static validateLengthUnit(length?: unknown, lengthUnit?: CableLengthUnit | string | null) {
    if (length != null && !lengthUnit) {
      throw new BadRequestException('Length unit is required when length is set');
    }
  }

  static validateTerminations(terminations: CableTerminationInput[]) {
    const aSide = terminations.filter((t) => t.cableSide === CableSide.A);
    const bSide = terminations.filter((t) => t.cableSide === CableSide.B);

    if (aSide.length !== 1 || bSide.length !== 1) {
      throw new BadRequestException('Cable must have exactly one A-side and one B-side termination');
    }

    const a = aSide[0];
    const b = bSide[0];

    if (a.terminationType === b.terminationType && a.terminationId === b.terminationId) {
      throw new BadRequestException('Cannot connect an object to itself');
    }

    const compatibleTypes = COMPATIBLE_TERMINATION_TYPES[a.terminationType];
    if (!compatibleTypes.includes(b.terminationType)) {
      throw new BadRequestException(
        `Incompatible termination types: ${a.terminationType} cannot connect to ${b.terminationType}`,
      );
    }
  }
}
