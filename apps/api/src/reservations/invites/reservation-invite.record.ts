import { BadRequestException, HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import type { CreateReservationInviteRequest, EditReservationInviteRequest } from '@repo/api-client';
import { Prisma } from '@repo/database';
import type { PaginationQuery } from '@repo/database/pagination';
import { paginateQuery } from '@repo/database/pagination';
import { hardwareSummaryInclude } from '@repo/device-domain';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { reservationInvitesPaginationConfig } from './reservation-invites.pagination';

const ReservationInvitePersistenceSchema = z.object({
  id: z.string(),
  inviteeEmail: z.string().nullable(),
  inviterEmail: z.string(),
  inviteeOrganizationId: z.string().nullable(),
  price: z.number(),
  billingFrequency: z.string(),
  manualBilling: z.boolean(),
  interruptibleNoticePeriod: z.number().nullable(),
  notes: z.string().nullable(),
  dateAccepted: z.date().nullable(),
  dateCreated: z.date(),
  dateDeleted: z.date().nullable(),
  dateExpires: z.date(),
  dateUpdated: z.date().nullable(),
  organizationId: z.string(),
  reservationId: z.string().nullable(),
});

export const reservationInviteAggregateInclude = {
  serversInReservationInvite: {
    include: {
      server: { include: { device: { include: hardwareSummaryInclude } } },
    },
  },
  inviteeOrganization: true,
} satisfies Prisma.ReservationInviteInclude;

export type ReservationInviteAggregate = Prisma.ReservationInviteGetPayload<{
  include: typeof reservationInviteAggregateInclude;
}>;

type CreateInviteDto = CreateReservationInviteRequest;
type EditInviteDto = EditReservationInviteRequest;

export class ReservationInviteRecord extends createActiveRecord(
  ReservationInvitePersistenceSchema,
  'reservationInvite',
  { tenantField: 'organizationId', actions: { read: 'reservation-invite:read' } },
) {
  get isActive(): boolean {
    return this.data.dateAccepted === null && this.data.dateDeleted === null && this.data.dateExpires > new Date();
  }

  get supplierOrganizationId(): string {
    return this.data.organizationId;
  }

  accept(): void {
    if (!this.isActive) {
      throw new ReservationInviteNotActiveException();
    }
    this.set({ dateAccepted: new Date() });
  }

  static async findActiveByIdOrThrowUnscoped(id: string): Promise<ReservationInviteRecord> {
    const delegate = this._unscopedDelegate();
    const row = await delegate.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException('Reservation invite not found');
    }
    const record: ReservationInviteRecord = this.fromRow(row);
    if (!record.isActive) {
      throw new BadRequestException('Reservation invite is not active');
    }
    return record;
  }

  static async softDeleteIfActiveUnscoped(id: string): Promise<boolean> {
    const result = await ActiveRecordRegistry.client.reservationInvite.updateMany({
      where: {
        id,
        dateAccepted: null,
        dateDeleted: null,
        dateExpires: { gt: new Date() },
      },
      data: { dateDeleted: new Date() },
    });
    return result.count > 0;
  }

  static async acceptIfActiveUnscoped(id: string): Promise<boolean> {
    const result = await ActiveRecordRegistry.client.reservationInvite.updateMany({
      where: {
        id,
        dateAccepted: null,
        dateDeleted: null,
        dateExpires: { gt: new Date() },
      },
      data: { dateAccepted: new Date() },
    });
    return result.count > 0;
  }

  static async findAggregateByIdUnscoped(id: string): Promise<ReservationInviteAggregate | null> {
    const delegate = this._unscopedDelegate();
    return delegate.findUnique({
      where: { id },
      include: reservationInviteAggregateInclude,
    });
  }

  static async findAggregatesByIdsUnscoped(ids: string[]): Promise<ReservationInviteAggregate[]> {
    const delegate = this._unscopedDelegate();
    return delegate.findMany({
      where: { id: { in: ids } },
      include: reservationInviteAggregateInclude,
    });
  }

  static async findActiveForInviteeAggregates(
    email: string,
    organizationIds: string[],
  ): Promise<ReservationInviteAggregate[]> {
    this.requireAction('read');
    const delegate = this._unscopedDelegate();
    const rows = await delegate.findMany({
      where: {
        OR: [
          {
            inviteeEmail: email,
            dateAccepted: null,
            dateDeleted: null,
            dateExpires: { gt: new Date() },
          },
          {
            inviteeOrganizationId: { in: organizationIds },
            dateAccepted: null,
            dateDeleted: null,
            dateExpires: { gt: new Date() },
          },
        ],
      },
      include: reservationInviteAggregateInclude,
    });

    return rows.filter((invite, idx, self) => idx === self.findIndex((i) => i.id === invite.id));
  }

  static async findActiveByDeviceForSupplierAggregates(
    deviceId: string,
    supplierId: string,
  ): Promise<ReservationInviteAggregate[]> {
    this.requireAction('read');
    const delegate = this._unscopedDelegate();
    return delegate.findMany({
      where: {
        dateDeleted: null,
        dateAccepted: null,
        dateExpires: { gt: new Date() },
        serversInReservationInvite: {
          some: { server: { deviceId, device: { supplierId } } },
        },
      },
      include: reservationInviteAggregateInclude,
    });
  }

  static async findActivePaginated(query: PaginationQuery) {
    this.requireAction('read');
    const result = await paginateQuery<ReservationInviteAggregate>(
      this._unscopedDelegate(),
      query,
      reservationInvitesPaginationConfig,
      {
        where: {
          dateExpires: { gt: new Date() },
          dateDeleted: null,
          dateAccepted: null,
        },
        include: reservationInviteAggregateInclude,
      },
    );
    return result;
  }

  static async getOrganizationMembersEmails(organizationId: string): Promise<string[]> {
    const members = await ActiveRecordRegistry.client.member.findMany({
      where: { organizationId, deletedAt: null },
      select: { user: { select: { email: true } } },
    });
    return members.map((m) => m.user.email);
  }

  static async findDevicesByIds(deviceIds: string[]): Promise<Array<{ id: string; supplierId: string | null }>> {
    return ActiveRecordRegistry.client.device.findMany({
      where: { id: { in: deviceIds } },
      select: { id: true, supplierId: true },
    });
  }

  private static async resolveServerIdsByDeviceIds(deviceIds: string[]): Promise<string[]> {
    const servers = await ActiveRecordRegistry.client.server.findMany({
      where: { deviceId: { in: deviceIds } },
      select: { id: true, deviceId: true },
    });
    const serverIdByDeviceId = new Map(servers.map((s) => [s.deviceId, s.id]));
    return deviceIds.map((deviceId) => {
      const serverId = serverIdByDeviceId.get(deviceId);
      if (!serverId) {
        throw new NotFoundException(`Server not found for device ${deviceId}`);
      }
      return serverId;
    });
  }

  static async createInviteWithDeviceLinks(dto: CreateInviteDto): Promise<ReservationInviteAggregate> {
    if (dto.dateExpires < new Date()) {
      throw new InvalidExpirationDateException();
    }

    return ActiveRecordRegistry.client.$transaction(async (tx) => {
      const delegate = this._unscopedDelegate(tx);
      const serverIds = await ReservationInviteRecord.resolveServerIdsByDeviceIds(dto.deviceIds);
      const created = await delegate.create({
        data: {
          id: randomUUID(),
          inviterEmail: dto.inviterEmail,
          inviteeEmail: dto.inviteeEmail && dto.inviteeEmail.trim() !== '' ? dto.inviteeEmail : null,
          dateExpires: new Date(dto.dateExpires),
          price: dto.price,
          billingFrequency: dto.billingFrequency,
          manualBilling: false,
          interruptibleNoticePeriod: dto.interruptibleNoticePeriod ?? null,
          notes: dto.notes ?? null,
          organization: { connect: { id: dto.organizationId } },
          serversInReservationInvite: {
            createMany: {
              data: serverIds.map((serverId) => ({ serverId })),
              skipDuplicates: true,
            },
          },
        },
        include: reservationInviteAggregateInclude,
      });

      return created;
    });
  }

  static async applyEditWithDeviceLinks(id: string, dto: EditInviteDto): Promise<ReservationInviteAggregate> {
    if (dto.dateExpires < new Date()) {
      throw new InvalidExpirationDateException();
    }

    return ActiveRecordRegistry.client.$transaction(async (tx) => {
      const delegate = this._unscopedDelegate(tx);
      const existing = await delegate.findUnique({ where: { id } });

      if (!existing) {
        throw new NotFoundException('Reservation invite not found');
      }
      if (!(existing.dateAccepted === null && existing.dateDeleted === null && existing.dateExpires > new Date())) {
        throw new BadRequestException('Reservation invite is not active');
      }

      const serverIds = await ReservationInviteRecord.resolveServerIdsByDeviceIds(dto.deviceIds);

      const updated = await delegate.update({
        where: { id },
        data: {
          price: dto.price,
          billingFrequency: dto.billingFrequency,
          dateExpires: dto.dateExpires,
          manualBilling: false,
          notes: dto.notes ?? null,
          interruptibleNoticePeriod: dto.interruptibleNoticePeriod ?? null,
          serversInReservationInvite: {
            deleteMany: { NOT: serverIds.map((serverId) => ({ serverId })) },
            createMany: {
              data: serverIds.map((serverId) => ({ serverId })),
              skipDuplicates: true,
            },
          },
        },
        include: reservationInviteAggregateInclude,
      });

      return updated;
    });
  }

  static async markManyDeletedUnscoped(ids: string[]): Promise<ReservationInviteAggregate[]> {
    const existing = await this.findAggregatesByIdsUnscoped(ids);
    if (existing.length !== ids.length) {
      throw new NotFoundException('One or more reservation invites not found');
    }
    for (const invite of existing) {
      const active = invite.dateAccepted === null && invite.dateDeleted === null && invite.dateExpires > new Date();
      if (!active) {
        throw new ReservationInviteNotActiveException();
      }
    }

    const delegate = this._unscopedDelegate();
    const now = new Date();
    const updates = ids.map((id) =>
      delegate.update({
        where: { id },
        data: { dateDeleted: now },
        include: reservationInviteAggregateInclude,
      }),
    );
    return ActiveRecordRegistry.client.$transaction(updates);
  }
}

export class ReservationInviteNotActiveException extends HttpException {
  constructor() {
    super('Reservation invite is no longer active', HttpStatus.BAD_REQUEST);
  }
}

export class InvalidExpirationDateException extends HttpException {
  constructor() {
    super('Invalid expiration date', HttpStatus.BAD_REQUEST);
  }
}
