import type { DeviceReservationInvite } from '@repo/api-client';
import { DeviceSpecHelper } from '@repo/device-domain';
import type { ReservationInviteAggregate } from './reservation-invite.record';

export class ReservationInvitePresenter {
  static toFullResponse(aggregate: ReservationInviteAggregate): DeviceReservationInvite {
    return {
      id: aggregate.id,
      deviceIds: aggregate.serversInReservationInvite.map((d) => d.server.device.id),
      inviteeEmail: aggregate.inviteeEmail,
      inviterEmail: aggregate.inviterEmail,
      inviteeOrganizationId: aggregate.inviteeOrganizationId,
      inviteeOrganizationName: aggregate.inviteeOrganization?.name,
      price: aggregate.price,
      billingFrequency: aggregate.billingFrequency,
      manualBilling: aggregate.manualBilling,
      interruptibleNoticePeriod: aggregate.interruptibleNoticePeriod,
      notes: aggregate.notes,
      dateAccepted: aggregate.dateAccepted,
      dateCreated: aggregate.dateCreated,
      dateDeleted: aggregate.dateDeleted,
      dateUpdated: aggregate.dateUpdated,
      dateExpires: aggregate.dateExpires,
      organizationId: aggregate.organizationId,
      reservationId: aggregate.reservationId,
      listing: ReservationInvitePresenter.listing(aggregate),
    };
  }

  static toDeviceListingResponse(aggregate: ReservationInviteAggregate): DeviceReservationInvite {
    return ReservationInvitePresenter.toFullResponse(aggregate);
  }

  static toUserResponse(aggregate: ReservationInviteAggregate) {
    return {
      id: aggregate.id,
      inviteeEmail: aggregate.inviteeEmail,
      inviterEmail: aggregate.inviterEmail,
      inviteeOrganizationId: aggregate.inviteeOrganizationId,
      dateAccepted: aggregate.dateAccepted,
      dateCreated: aggregate.dateCreated,
      dateDeleted: aggregate.dateDeleted,
      dateUpdated: aggregate.dateUpdated,
      dateExpires: aggregate.dateExpires,
      organizationId: aggregate.organizationId,
      reservationId: aggregate.reservationId,
      price: aggregate.price,
      billingFrequency: aggregate.billingFrequency,
      deviceIds: aggregate.serversInReservationInvite.map((d) => d.server.device.id),
    };
  }

  static toUserListResponse(aggregate: ReservationInviteAggregate) {
    return {
      ...ReservationInvitePresenter.toUserResponse(aggregate),
      manualBilling: aggregate.manualBilling,
      isActive: ReservationInvitePresenter.isActive(aggregate),
      listing: ReservationInvitePresenter.listing(aggregate),
    };
  }

  static isActive(aggregate: ReservationInviteAggregate): boolean {
    return aggregate.dateAccepted === null && aggregate.dateDeleted === null && aggregate.dateExpires > new Date();
  }

  private static listing(aggregate: ReservationInviteAggregate) {
    const first = aggregate.serversInReservationInvite[0];
    if (!first) return null;
    const device = first.server.device;
    const hw = DeviceSpecHelper.hardwareSummary(device);
    return {
      id: device.id,
      deviceId: device.id,
      name: device.name,
      specs: {
        gpu: { model: hw.gpuModel },
        cpu: { cores: hw.cpuCoreCount },
        memory: hw.memoryGb,
      },
    };
  }
}
