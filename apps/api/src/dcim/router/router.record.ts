import { NotFoundException } from '@nestjs/common';
import { createActiveRecord } from '@repo/active-record';
import type { RoutersQuery, UpdateRouterRequest } from '@repo/api-client';
import { DeviceRole, DeviceStatus, Prisma, RouterPowerStatus } from '@repo/database';
import type { PaginatedResult } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { DeviceSpecColumnsSchema } from '@repo/device-domain';
import { sanitizeNickname } from 'src/common/sanitize-nickname.util';
import { z } from 'zod';
import { routerPaginationConfig } from './router.pagination';

const routerAggregateInclude = {
  router: true,
  supplier: { select: { id: true, name: true } },
  zone: { select: { name: true, region: { select: { name: true } } } },
} satisfies Prisma.DeviceInclude;

export const RouterPersistenceSchema = DeviceSpecColumnsSchema.extend({
  router: z.object({
    id: z.string(),
    routerType: z.string().nullable(),
    bgpAsn: z.number().int().nullable(),
    powerStatus: z.nativeEnum(RouterPowerStatus).nullable(),
  }),
  supplier: z.object({ id: z.string(), name: z.string() }).nullable(),
});

type _RawRouterAggregate = Prisma.DeviceGetPayload<{ include: typeof routerAggregateInclude }>;
export type RouterAggregate = Omit<_RawRouterAggregate, 'router'> & {
  router: NonNullable<_RawRouterAggregate['router']>;
};

export class RouterRecord extends createActiveRecord(RouterPersistenceSchema, 'device', {
  tenantField: 'supplierId',
  extension: { relationName: 'router' },
  discriminator: { role: DeviceRole.Router },
  softDeleteField: 'deletedAt',
  include: routerAggregateInclude,
  actions: { read: 'device:read', create: 'device:create', update: 'device:update', delete: 'device:delete' },
}) {
  get data(): Readonly<RouterAggregate> {
    return super.data as unknown as Readonly<RouterAggregate>;
  }

  static async findByDeviceId(
    deviceId: string,
    opts?: { tx?: Prisma.TransactionClient; includeDeleted?: boolean },
  ): Promise<RouterRecord | null> {
    this.requireAction('read');
    return this.findById(deviceId, opts);
  }

  static async findByDeviceIdOrThrow(
    deviceId: string,
    opts?: { tx?: Prisma.TransactionClient; includeDeleted?: boolean },
  ): Promise<RouterRecord> {
    const record = await this.findByDeviceId(deviceId, opts);
    if (!record) throw new NotFoundException('Router not found');
    return record;
  }

  static async listPaginated(query: RoutersQuery): Promise<PaginatedResult<RouterAggregate>> {
    this.requireAction('read');
    const where: Prisma.DeviceWhereInput = {};
    if (query.zoneId) where.zoneId = query.zoneId;
    if (query.decommissioned) where.deletedAt = { not: null };
    else where.status = DeviceStatus.ACTIVE;

    return paginateQuery<RouterAggregate>(
      this._paginationDelegate<RouterAggregate>({ includeDeleted: query.decommissioned ?? false }),
      query,
      routerPaginationConfig,
      { where },
    );
  }

  static async updateByDeviceId(deviceId: string, input: UpdateRouterRequest): Promise<RouterRecord> {
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

  private applyPatch(input: UpdateRouterRequest): void {
    const devicePatch: { nickname?: string | null } = {};
    if (input.nickname !== undefined) {
      devicePatch.nickname = input.nickname === null ? null : sanitizeNickname(input.nickname).trim() || null;
    }

    const routerPatch: {
      routerType?: string | null;
      bgpAsn?: number | null;
      powerStatus?: RouterPowerStatus | null;
    } = {};
    if (input.routerType !== undefined) routerPatch.routerType = input.routerType;
    if (input.bgpAsn !== undefined) routerPatch.bgpAsn = input.bgpAsn;
    if (input.powerStatus !== undefined) routerPatch.powerStatus = input.powerStatus;

    this.set({ ...devicePatch, ...(Object.keys(routerPatch).length > 0 ? { router: routerPatch } : {}) });
  }
}
