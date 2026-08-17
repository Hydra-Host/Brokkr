import { Injectable } from '@nestjs/common';
import { BillingFrequency } from '@repo/database';
import { HOURS_IN_WEEK } from '@repo/utils';
import { PrismaClient } from 'src/prisma/prisma.client';
import { ReservationInviteRecord } from './invites/reservation-invite.record';
import { ReservationsService } from './reservations.service';

const DEFAULT_INTERRUPTIBLE_NOTICE_MS = 300_000;

export interface CreateProvisionReservationInput {
  deviceId: string;
  userId: string;
  organizationId: string;
  internalProvision: boolean;
  isInterruptible: boolean;
}

@Injectable()
export class ReservationProvisioningService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly reservationsService: ReservationsService,
  ) {}

  async createForProvision(input: CreateProvisionReservationInput): Promise<string> {
    const { deviceId, userId, organizationId, internalProvision, isInterruptible } = input;

    const invite = await this.resolveApplicableInvite(deviceId, userId, organizationId);

    const pricing = invite
      ? {
          price: invite.price,
          billingFrequency: invite.billingFrequency,
          interruptibleNoticePeriod: invite.interruptibleNoticePeriod,
          notes: invite.notes,
          reservationInviteId: invite.id,
        }
      : await this.deriveDirectPricing(deviceId, isInterruptible, internalProvision);

    const reservation = await this.reservationsService.createReservation({
      reserverId: userId,
      customerId: organizationId,
      deviceIds: [deviceId],
      internalProvision,
      notes: pricing.notes,
      price: pricing.price,
      billingFrequency: pricing.billingFrequency,
      interruptibleNoticePeriod: pricing.interruptibleNoticePeriod,
      reservationInviteId: pricing.reservationInviteId,
    });

    return reservation.id;
  }

  async acceptInviteForReservation(reservationId: string): Promise<boolean> {
    const reservation = await this.prisma.reservation.findUnique({
      where: { id: reservationId },
      select: { reservationInvite: { select: { id: true } } },
    });
    const inviteId = reservation?.reservationInvite?.id;
    if (!inviteId) return false;
    return ReservationInviteRecord.acceptIfActiveUnscoped(inviteId);
  }

  private async resolveApplicableInvite(deviceId: string, userId: string, organizationId: string) {
    const server = await this.prisma.server.findUnique({
      where: { deviceId },
      select: {
        serversInReservationInvite: {
          where: {
            reservationInvite: { dateAccepted: null, dateDeleted: null, dateExpires: { gt: new Date() } },
          },
          include: { reservationInvite: true },
          take: 1,
        },
      },
    });

    const invite = server?.serversInReservationInvite[0]?.reservationInvite;
    if (!invite) return null;

    if (invite.inviteeOrganizationId === organizationId) return invite;

    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (user && invite.inviteeEmail && user.email === invite.inviteeEmail) return invite;

    return null;
  }

  private async deriveDirectPricing(deviceId: string, isInterruptible: boolean, internalProvision: boolean) {
    const interruptibleNoticePeriod = isInterruptible ? DEFAULT_INTERRUPTIBLE_NOTICE_MS : null;

    if (internalProvision) {
      return {
        price: 0,
        billingFrequency: BillingFrequency.WEEKLY,
        interruptibleNoticePeriod,
        notes: null,
        reservationInviteId: null,
      };
    }

    const server = await this.prisma.server.findUnique({
      where: { deviceId },
      select: { hourlyPrice: true, floorHourlyPrice: true },
    });

    const rate = isInterruptible && server?.floorHourlyPrice ? server.floorHourlyPrice : server?.hourlyPrice;
    if (!rate) {
      throw new Error(`Device ${deviceId} has no hourly price; cannot price a non-invite reservation`);
    }

    const weeklyPrice = Math.round(rate.toNumber() * HOURS_IN_WEEK);

    return {
      price: weeklyPrice,
      billingFrequency: BillingFrequency.WEEKLY,
      interruptibleNoticePeriod,
      notes: null,
      reservationInviteId: null,
    };
  }
}
