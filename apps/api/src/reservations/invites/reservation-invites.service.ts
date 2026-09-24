import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateReservationInviteRequest, EditReservationInviteRequest } from '@repo/api-client';
import { paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { interruptibleNoticePeriodRejectionMessage, inviteContractTypeWriteRejection } from '@repo/utils';
import { ContextService } from 'src/common/context/context.service';
import { EmailService } from 'src/email/email.service';
import { InventoryRecord } from 'src/inventory/inventory.record';
import { HostPluginGateBus } from 'src/plugin-host/host-plugin-gate-bus';
import { ReservationInvitePresenter } from './reservation-invite.presenter';
import { ReservationInviteAggregate, ReservationInviteRecord } from './reservation-invite.record';

type InviteeScope = {
  inviteeEmail: string | null;
  inviteeOrganizationId: string | null;
};

@Injectable()
export class ReservationInvitesService {
  constructor(
    private readonly contextService: ContextService,
    private readonly emailService: EmailService,
    private readonly gateBus: HostPluginGateBus,
  ) {}

  async createReservationInviteAsASupplyCustomer(dto: CreateReservationInviteRequest) {
    this.contextService.requirePermission('reservation-invite', 'create');
    if (dto.inviterEmail !== this.contextService.email) {
      throw new BadRequestException('Inviter must be the same as the current user');
    }
    await this.assertDeviceAvailableForInvite(dto.deviceIds[0]);

    const contractTypeRejection = inviteContractTypeWriteRejection({
      contractType: dto.contractType,
      interruptibleNoticePeriod: dto.interruptibleNoticePeriod,
    });
    if (contractTypeRejection) {
      throw new BadRequestException(contractTypeRejection);
    }
    if (dto.interruptibleNoticePeriod != null) {
      throw new BadRequestException(interruptibleNoticePeriodRejectionMessage());
    }

    await this.checkDevicesBelongToSupplyOrganization({ deviceIds: dto.deviceIds });

    await this.gateBus.runGate('reservation.invite.authorize', {
      supplierOrganizationId: this.contextService.organizationId,
    });

    const sanitisedDto: CreateReservationInviteRequest = {
      ...dto,
      organizationId: this.contextService.organizationId,
      interruptibleNoticePeriod: null,
    };

    const aggregate = await ReservationInviteRecord.createInviteWithDeviceLinks(sanitisedDto);

    await this.emailService.send.reservationInvite({
      from: aggregate.inviterEmail,
      emails: aggregate.inviteeEmail ? [aggregate.inviteeEmail] : [],
      reservationEndDate: aggregate.dateExpires.toLocaleDateString(),
    });

    return ReservationInvitePresenter.toFullResponse(aggregate);
  }

  async fetchAllReservationInvitesByDeviceIdForSupplier(deviceId: string, query: PaginationQuery) {
    // Scope is device.supplierId, not invite.organizationId — suppliers must also see admin-issued invites.
    const supplierId = this.contextService.organizationId;
    const aggregates = await ReservationInviteRecord.findActiveByDeviceForSupplierAggregates(deviceId, supplierId);
    const responses = aggregates.map((aggregate) => ReservationInvitePresenter.toDeviceListingResponse(aggregate));
    return paginateArray(responses, query, { searchableFields: [] });
  }

  async editReservationInviteAsASupplyCustomer(id: string, dto: EditReservationInviteRequest) {
    this.contextService.requirePermission('reservation-invite', 'update');
    const aggregate = await this.restoreActiveAggregate(id);
    this.checkInviterBelongsToSupplyOrganization(aggregate);
    await this.checkDevicesBelongToSupplyOrganization({ deviceIds: dto.deviceIds });

    const contractTypeRejection = inviteContractTypeWriteRejection({
      contractType: dto.contractType,
      interruptibleNoticePeriod: dto.interruptibleNoticePeriod,
    });
    if (contractTypeRejection) {
      throw new BadRequestException(contractTypeRejection);
    }
    if (dto.interruptibleNoticePeriod != null) {
      throw new BadRequestException(interruptibleNoticePeriodRejectionMessage());
    }

    const updated = await ReservationInviteRecord.applyEditWithDeviceLinks(id, {
      ...dto,
      interruptibleNoticePeriod: null,
    });
    return ReservationInvitePresenter.toFullResponse(updated);
  }

  async deleteReservationInviteAsASupplyCustomer(id: string): Promise<void> {
    this.contextService.requirePermission('reservation-invite', 'delete');
    const aggregate = await this.restoreActiveAggregate(id);
    this.checkInviterBelongsToSupplyOrganization(aggregate);
    const deleted = await ReservationInviteRecord.softDeleteIfActiveUnscoped(id);
    if (!deleted) {
      throw new BadRequestException('Reservation invite is not active');
    }
  }

  async acceptReservationInvite(id: string): Promise<void> {
    const record = await ReservationInviteRecord.findActiveByIdOrThrowUnscoped(id);
    this.checkInviteeBelongsToOrganization({
      inviteeEmail: record.data.inviteeEmail,
      inviteeOrganizationId: record.data.inviteeOrganizationId,
    });
    record.accept();
    await record.save();
  }

  async fetchReservationInviteForUser(id: string) {
    const aggregate = await this.restoreActiveAggregate(id);
    this.checkInviteeBelongsToOrganization({
      inviteeEmail: aggregate.inviteeEmail,
      inviteeOrganizationId: aggregate.inviteeOrganizationId,
    });
    return ReservationInvitePresenter.toUserResponse(aggregate);
  }

  async fetchAllReservationInvitesForUser(query: PaginationQuery) {
    const identity = this.contextService.requireIdentity;
    const email = this.contextService.email;

    const aggregates = await ReservationInviteRecord.findActiveForInviteeAggregates(email, [identity.organizationId]);

    const responses = aggregates
      .map((aggregate) => ReservationInvitePresenter.toUserListResponse(aggregate))
      .filter((invite) => invite.isActive);
    return paginateArray(responses, query, { searchableFields: [] });
  }

  private async restoreActiveAggregate(id: string): Promise<ReservationInviteAggregate> {
    const aggregate = await ReservationInviteRecord.findAggregateByIdUnscoped(id);
    if (!aggregate) {
      throw new NotFoundException('Reservation invite not found');
    }
    if (!ReservationInvitePresenter.isActive(aggregate)) {
      throw new BadRequestException('Reservation invite is not active');
    }
    return aggregate;
  }

  private async assertDeviceAvailableForInvite(deviceId: string) {
    const aggregate = await InventoryRecord.findAvailableForInviteById(deviceId);
    if (!aggregate) {
      throw new NotFoundException('Listing not found');
    }
    return aggregate;
  }

  private checkInviterBelongsToSupplyOrganization(aggregate: ReservationInviteAggregate) {
    const organizationId = this.contextService.organizationId;
    if (aggregate.organizationId !== organizationId) {
      throw new NotFoundException('Reservation invite not found');
    }
  }

  private async checkDevicesBelongToSupplyOrganization(dto: { deviceIds: string[] }) {
    const identity = this.contextService.requireIdentity;
    const devices = await ReservationInviteRecord.findDevicesByIds(dto.deviceIds);
    if (devices.some((device) => device.supplierId !== identity.organizationId)) {
      throw new BadRequestException('Devices do not belong to supply organization');
    }
  }

  private checkInviteeBelongsToOrganization(scope: InviteeScope) {
    const identity = this.contextService.requireIdentity;
    const email = this.contextService.email;
    const isEmailMatch = scope.inviteeEmail === email;
    const isOrganizationMatch = scope.inviteeOrganizationId && identity.organizationId === scope.inviteeOrganizationId;
    if (!isEmailMatch && !isOrganizationMatch) {
      throw new NotFoundException('Reservation invite not found');
    }
  }
}
