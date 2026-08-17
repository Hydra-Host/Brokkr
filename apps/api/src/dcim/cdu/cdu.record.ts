import { NotFoundException } from '@nestjs/common';
import { createActiveRecord } from '@repo/active-record';
import type { CdusQuery, UpdateCduRequest } from '@repo/api-client';
import { Airflow, CduPowerStatus, DeviceRole, DeviceStatus, Prisma } from '@repo/database';
import type { PaginatedResult } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { DeviceSpecColumnsSchema } from '@repo/device-domain';
import { sanitizeNickname } from 'src/common/sanitize-nickname.util';
import { z } from 'zod';
import { cduPaginationConfig } from './cdu.pagination';

const cduAggregateInclude = {
  cdu: true,
  supplier: { select: { id: true, name: true } },
  zone: { select: { name: true, region: { select: { name: true } } } },
} satisfies Prisma.DeviceInclude;

export const CduPersistenceSchema = DeviceSpecColumnsSchema.extend({
  cdu: z.object({
    id: z.string(),
    coolantType: z.string().nullable(),
    ratedFlowRateLpm: z.number().nullable(),
    ratedThermalCapacityKw: z.number().int().nullable(),
    airflow: z.nativeEnum(Airflow),
    powerStatus: z.nativeEnum(CduPowerStatus).nullable(),
  }),
  supplier: z.object({ id: z.string(), name: z.string() }).nullable(),
});

type _RawCduAggregate = Prisma.DeviceGetPayload<{ include: typeof cduAggregateInclude }>;
export type CduAggregate = Omit<_RawCduAggregate, 'cdu'> & { cdu: NonNullable<_RawCduAggregate['cdu']> };

export class CduRecord extends createActiveRecord(CduPersistenceSchema, 'device', {
  tenantField: 'supplierId',
  extension: { relationName: 'cdu' },
  discriminator: { role: DeviceRole.CDU },
  softDeleteField: 'deletedAt',
  include: cduAggregateInclude,
  actions: { read: 'device:read', create: 'device:create', update: 'device:update', delete: 'device:delete' },
}) {
  get data(): Readonly<CduAggregate> {
    return super.data as unknown as Readonly<CduAggregate>;
  }

  static async findByDeviceId(
    deviceId: string,
    opts?: { tx?: Prisma.TransactionClient; includeDeleted?: boolean },
  ): Promise<CduRecord | null> {
    this.requireAction('read');
    return this.findById(deviceId, opts);
  }

  static async findByDeviceIdOrThrow(
    deviceId: string,
    opts?: { tx?: Prisma.TransactionClient; includeDeleted?: boolean },
  ): Promise<CduRecord> {
    const record = await this.findByDeviceId(deviceId, opts);
    if (!record) throw new NotFoundException('CDU not found');
    return record;
  }

  static async listPaginated(query: CdusQuery): Promise<PaginatedResult<CduAggregate>> {
    this.requireAction('read');
    const where: Prisma.DeviceWhereInput = {};
    if (query.zoneId) where.zoneId = query.zoneId;
    if (query.decommissioned) where.deletedAt = { not: null };
    else where.status = DeviceStatus.ACTIVE;

    return paginateQuery<CduAggregate>(
      this._paginationDelegate<CduAggregate>({ includeDeleted: query.decommissioned ?? false }),
      query,
      cduPaginationConfig,
      { where },
    );
  }

  static async updateByDeviceId(deviceId: string, input: UpdateCduRequest): Promise<CduRecord> {
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

  private applyPatch(input: UpdateCduRequest): void {
    const devicePatch: { nickname?: string | null } = {};
    if (input.nickname !== undefined) {
      devicePatch.nickname = input.nickname === null ? null : sanitizeNickname(input.nickname).trim() || null;
    }

    const cduPatch: {
      coolantType?: string | null;
      ratedFlowRateLpm?: number | null;
      ratedThermalCapacityKw?: number | null;
      airflow?: Airflow;
      powerStatus?: CduPowerStatus | null;
    } = {};
    if (input.coolantType !== undefined) cduPatch.coolantType = input.coolantType;
    if (input.ratedFlowRateLpm !== undefined) cduPatch.ratedFlowRateLpm = input.ratedFlowRateLpm;
    if (input.ratedThermalCapacityKw !== undefined) cduPatch.ratedThermalCapacityKw = input.ratedThermalCapacityKw;
    if (input.airflow !== undefined) cduPatch.airflow = input.airflow;
    if (input.powerStatus !== undefined) cduPatch.powerStatus = input.powerStatus;

    this.set({ ...devicePatch, ...(Object.keys(cduPatch).length > 0 ? { cdu: cduPatch } : {}) });
  }
}
