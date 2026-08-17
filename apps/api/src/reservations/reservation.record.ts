import { HttpException, HttpStatus, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry, createActiveRecord } from '@repo/active-record';
import { BillingFrequency, Prisma } from '@repo/database';
import { hardwareSummaryInclude } from '@repo/device-domain';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { generateObjectId } from '../utils/generate-object-id';
import type { CreateReservationInput, ReservationAggregate } from './types/reservations.types';

export const ReservationPersistenceSchema = z.object({
  id: z.string(),
  internalProvision: z.boolean().nullable(),
  endDate: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date().nullable(),
  notes: z.string().nullable(),
  reserverId: z.string(),
  customerId: z.string(),
  price: z.number().int().nullable(),
  billingFrequency: z.nativeEnum(BillingFrequency).nullable(),
  interruptibleNoticePeriod: z.number().int().nullable(),
});

const reservationAggregateInclude = {
  customer: true,
  reserver: true,
  reservationInvite: true,
  serversInReservation: {
    include: {
      server: { include: { device: { include: { supplier: true, ...hardwareSummaryInclude } } } },
    },
  },
} satisfies Prisma.ReservationInclude;

export class ReservationRecord extends createActiveRecord(ReservationPersistenceSchema, 'reservation', {
  tenantField: 'customerId',
}) {
  static generateObjectId() {
    return generateObjectId('res');
  }

  static async findActiveByDeviceIdUnscoped(deviceId: string) {
    const delegate = this._unscopedDelegate();
    return delegate.findFirst({
      where: {
        serversInReservation: {
          some: { server: { deviceId } },
        },
        endDate: null,
      },
    });
  }

  static async findAggregateByIdUnscoped(id: string): Promise<ReservationAggregate | null> {
    const reservation = await this._unscopedDelegate().findUnique({
      where: { id },
      include: reservationAggregateInclude,
    });

    if (!reservation) return null;

    const { serversInReservation, ...rest } = reservation;
    return {
      ...rest,
      devices: serversInReservation.map((s) => s.server.device),
    };
  }

  static async createReservation(data: CreateReservationInput): Promise<ReservationAggregate> {
    const reservationId = randomUUID();

    const client = ActiveRecordRegistry.client;
    const deviceIds = data.deviceIds;
    const servers = await client.server.findMany({
      where: { deviceId: { in: deviceIds } },
      select: { id: true, deviceId: true },
    });
    const serverIdByDeviceId = new Map(servers.map((s) => [s.deviceId, s.id]));
    const serverIdsForReservation = deviceIds.map((deviceId) => {
      const serverId = serverIdByDeviceId.get(deviceId);
      if (!serverId) {
        throw new NotFoundException(`Server not found for device ${deviceId}`);
      }
      return serverId;
    });

    const delegate = this._unscopedDelegate();
    await delegate.create({
      data: {
        id: reservationId,
        reserver: { connect: { id: data.reserverId } },
        customer: { connect: { id: data.customerId } },
        serversInReservation: {
          createMany: {
            data: serverIdsForReservation.map((serverId) => ({ serverId })),
          },
        },
        ...(data.reservationInviteId && {
          reservationInvite: { connect: { id: data.reservationInviteId } },
        }),
        endDate: null,
        internalProvision: data.internalProvision,
        notes: data.notes,
        price: data.price,
        billingFrequency: data.billingFrequency,
        interruptibleNoticePeriod: data.interruptibleNoticePeriod,
      },
    });

    const aggregate = await ReservationRecord.findAggregateByIdUnscoped(reservationId);
    if (!aggregate) {
      throw new HttpException('Failed to load created reservation', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return aggregate;
  }

  static async endByIdUnscoped(id: string): Promise<ReservationAggregate> {
    const delegate = this._unscopedDelegate();
    const existing = await delegate.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('Reservation not found');
    }
    await delegate.update({
      where: { id },
      data: { endDate: new Date() },
    });
    const aggregate = await ReservationRecord.findAggregateByIdUnscoped(id);
    if (!aggregate) {
      throw new HttpException('Failed to reload ended reservation', HttpStatus.INTERNAL_SERVER_ERROR);
    }
    return aggregate;
  }

  static async endByDeviceIdUnscoped(deviceId: string): Promise<ReservationAggregate | null> {
    const reservation = await ReservationRecord.findActiveByDeviceIdUnscoped(deviceId);
    if (!reservation) return null;
    return ReservationRecord.endByIdUnscoped(reservation.id);
  }

  static async endActiveByIdUnscoped(id: string, tx?: Prisma.TransactionClient): Promise<boolean> {
    const delegate = this._unscopedDelegate(tx);
    const result = await delegate.updateMany({
      where: { id, endDate: null },
      data: { endDate: new Date() },
    });
    return result.count > 0;
  }
}
