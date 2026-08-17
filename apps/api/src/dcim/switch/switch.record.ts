import { NotFoundException } from '@nestjs/common';
import { createActiveRecord } from '@repo/active-record';
import type { SwitchesQuery, UpdateSwitchRequest } from '@repo/api-client';
import { DeviceRole, DeviceStatus, Prisma, SwitchPowerStatus } from '@repo/database';
import type { PaginatedResult } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { DeviceSpecColumnsSchema } from '@repo/device-domain';
import { sanitizeNickname } from 'src/common/sanitize-nickname.util';
import { z } from 'zod';
import { switchPaginationConfig } from './switch.pagination';

const switchAggregateInclude = {
  switch: true,
  supplier: { select: { id: true, name: true } },
  zone: { select: { name: true, region: { select: { name: true } } } },
} satisfies Prisma.DeviceInclude;

export const SwitchPersistenceSchema = DeviceSpecColumnsSchema.extend({
  switch: z.object({
    id: z.string(),
    switchRole: z.string().nullable(),
    fabric: z.string().nullable(),
    portCount: z.number().int().nullable(),
    powerStatus: z.nativeEnum(SwitchPowerStatus).nullable(),
  }),
  supplier: z.object({ id: z.string(), name: z.string() }).nullable(),
});

type _RawSwitchAggregate = Prisma.DeviceGetPayload<{ include: typeof switchAggregateInclude }>;
export type SwitchAggregate = Omit<_RawSwitchAggregate, 'switch'> & {
  switch: NonNullable<_RawSwitchAggregate['switch']>;
};

export class SwitchRecord extends createActiveRecord(SwitchPersistenceSchema, 'device', {
  tenantField: 'supplierId',
  extension: { relationName: 'switch' },
  discriminator: { role: DeviceRole.Switch },
  softDeleteField: 'deletedAt',
  include: switchAggregateInclude,
  actions: { read: 'device:read', create: 'device:create', update: 'device:update', delete: 'device:delete' },
}) {
  get data(): Readonly<SwitchAggregate> {
    return super.data as unknown as Readonly<SwitchAggregate>;
  }

  static async findByDeviceId(
    deviceId: string,
    opts?: { tx?: Prisma.TransactionClient; includeDeleted?: boolean },
  ): Promise<SwitchRecord | null> {
    this.requireAction('read');
    return this.findById(deviceId, opts);
  }

  static async findByDeviceIdOrThrow(
    deviceId: string,
    opts?: { tx?: Prisma.TransactionClient; includeDeleted?: boolean },
  ): Promise<SwitchRecord> {
    const record = await this.findByDeviceId(deviceId, opts);
    if (!record) throw new NotFoundException('Switch not found');
    return record;
  }

  static async listPaginated(query: SwitchesQuery): Promise<PaginatedResult<SwitchAggregate>> {
    this.requireAction('read');
    const where: Prisma.DeviceWhereInput = {};
    if (query.zoneId) where.zoneId = query.zoneId;
    if (query.decommissioned) where.deletedAt = { not: null };
    else where.status = DeviceStatus.ACTIVE;

    return paginateQuery<SwitchAggregate>(
      this._paginationDelegate<SwitchAggregate>({ includeDeleted: query.decommissioned ?? false }),
      query,
      switchPaginationConfig,
      { where },
    );
  }

  static async updateByDeviceId(deviceId: string, input: UpdateSwitchRequest): Promise<SwitchRecord> {
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

  private applyPatch(input: UpdateSwitchRequest): void {
    const devicePatch: { nickname?: string | null } = {};
    if (input.nickname !== undefined) {
      devicePatch.nickname = input.nickname === null ? null : sanitizeNickname(input.nickname).trim() || null;
    }

    const switchPatch: {
      switchRole?: string | null;
      fabric?: string | null;
      portCount?: number | null;
      powerStatus?: SwitchPowerStatus | null;
    } = {};
    if (input.switchRole !== undefined) switchPatch.switchRole = input.switchRole;
    if (input.fabric !== undefined) switchPatch.fabric = input.fabric;
    if (input.portCount !== undefined) switchPatch.portCount = input.portCount;
    if (input.powerStatus !== undefined) switchPatch.powerStatus = input.powerStatus;

    this.set({ ...devicePatch, ...(Object.keys(switchPatch).length > 0 ? { switch: switchPatch } : {}) });
  }
}
