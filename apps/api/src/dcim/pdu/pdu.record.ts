import { NotFoundException } from '@nestjs/common';
import { createActiveRecord } from '@repo/active-record';
import type { PdusQuery, UpdatePduRequest } from '@repo/api-client';
import { DeviceRole, DeviceStatus, PduPowerStatus, Prisma } from '@repo/database';
import type { PaginatedResult } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { DeviceSpecColumnsSchema } from '@repo/device-domain';
import { sanitizeNickname } from 'src/common/sanitize-nickname.util';
import { z } from 'zod';
import { pduPaginationConfig } from './pdu.pagination';

const pduAggregateInclude = {
  pdu: true,
  supplier: { select: { id: true, name: true } },
  zone: { select: { name: true, region: { select: { name: true } } } },
} satisfies Prisma.DeviceInclude;

export const PduPersistenceSchema = DeviceSpecColumnsSchema.extend({
  pdu: z.object({
    id: z.string(),
    outletCount: z.number().int().nullable(),
    ratedAmperage: z.number().int().nullable(),
    voltageType: z.string().nullable(),
    powerStatus: z.nativeEnum(PduPowerStatus).nullable(),
  }),
  supplier: z.object({ id: z.string(), name: z.string() }).nullable(),
});

type _RawPduAggregate = Prisma.DeviceGetPayload<{ include: typeof pduAggregateInclude }>;
export type PduAggregate = Omit<_RawPduAggregate, 'pdu'> & { pdu: NonNullable<_RawPduAggregate['pdu']> };

export class PduRecord extends createActiveRecord(PduPersistenceSchema, 'device', {
  tenantField: 'supplierId',
  extension: { relationName: 'pdu' },
  discriminator: { role: DeviceRole.PDU },
  softDeleteField: 'deletedAt',
  include: pduAggregateInclude,
  actions: { read: 'device:read', create: 'device:create', update: 'device:update', delete: 'device:delete' },
}) {
  get data(): Readonly<PduAggregate> {
    return super.data as unknown as Readonly<PduAggregate>;
  }

  static async findByDeviceId(
    deviceId: string,
    opts?: { tx?: Prisma.TransactionClient; includeDeleted?: boolean },
  ): Promise<PduRecord | null> {
    this.requireAction('read');
    return this.findById(deviceId, opts);
  }

  static async findByDeviceIdOrThrow(
    deviceId: string,
    opts?: { tx?: Prisma.TransactionClient; includeDeleted?: boolean },
  ): Promise<PduRecord> {
    const record = await this.findByDeviceId(deviceId, opts);
    if (!record) throw new NotFoundException('PDU not found');
    return record;
  }

  static async listPaginated(query: PdusQuery): Promise<PaginatedResult<PduAggregate>> {
    this.requireAction('read');
    const where: Prisma.DeviceWhereInput = {};
    if (query.zoneId) where.zoneId = query.zoneId;
    if (query.decommissioned) where.deletedAt = { not: null };
    else where.status = DeviceStatus.ACTIVE;

    return paginateQuery<PduAggregate>(
      this._paginationDelegate<PduAggregate>({ includeDeleted: query.decommissioned ?? false }),
      query,
      pduPaginationConfig,
      { where },
    );
  }

  static async updateByDeviceId(deviceId: string, input: UpdatePduRequest): Promise<PduRecord> {
    this.requireAction('update');
    const record = await this.findByDeviceIdOrThrow(deviceId);
    record.applyPatch(input);
    await record.save();
    return record;
  }

  static async decommissionByDeviceId(deviceId: string): Promise<void> {
    this.requireAction('delete');
    const record = await this.findByDeviceIdOrThrow(deviceId);
    record.set({ deletedAt: new Date(), status: DeviceStatus.MAINTENANCE });
    await record.save();
  }

  private applyPatch(input: UpdatePduRequest): void {
    const devicePatch: { nickname?: string | null } = {};
    if (input.nickname !== undefined) {
      devicePatch.nickname = input.nickname === null ? null : sanitizeNickname(input.nickname).trim() || null;
    }

    const pduPatch: {
      outletCount?: number | null;
      ratedAmperage?: number | null;
      voltageType?: string | null;
      powerStatus?: PduPowerStatus | null;
    } = {};
    if (input.outletCount !== undefined) pduPatch.outletCount = input.outletCount;
    if (input.ratedAmperage !== undefined) pduPatch.ratedAmperage = input.ratedAmperage;
    if (input.voltageType !== undefined) pduPatch.voltageType = input.voltageType;
    if (input.powerStatus !== undefined) pduPatch.powerStatus = input.powerStatus;

    this.set({ ...devicePatch, ...(Object.keys(pduPatch).length > 0 ? { pdu: pduPatch } : {}) });
  }
}
