import { LifecycleGateRejection } from '@hydrahost/plugin-sdk';
import { Test } from '@nestjs/testing';
import type { CreateReservationInviteRequest, DeviceReservationInvite } from '@repo/api-client';
import { BillingFrequency } from '@repo/database';
import { ContractType } from '@repo/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ContextService } from 'src/common/context/context.service';
import { EmailService } from 'src/email/email.service';
import { InventoryRecord } from 'src/inventory/inventory.record';
import { GateUnavailableError, HostPluginGateBus } from 'src/plugin-host/host-plugin-gate-bus';
import { ReservationInvitePresenter } from '../reservation-invite.presenter';
import { ReservationInviteRecord } from '../reservation-invite.record';
import { ReservationInvitesService } from '../reservation-invites.service';

const SUPPLIER_ORG = 'supplier-org-1';
const DEVICE_ID = 'device-1';

const dto: CreateReservationInviteRequest = {
  inviterEmail: 'supplier@example.com',
  inviteeEmail: 'buyer@example.com',
  organizationId: SUPPLIER_ORG,
  price: 100,
  billingFrequency: BillingFrequency.WEEKLY,
  dateExpires: new Date('2027-01-01T00:00:00Z'),
  deviceIds: [DEVICE_ID],
};

const createdInvite: DeviceReservationInvite = {
  id: 'invite-1',
  deviceIds: [DEVICE_ID],
  inviteeEmail: dto.inviteeEmail,
  inviterEmail: dto.inviterEmail,
  inviteeOrganizationId: null,
  price: dto.price,
  billingFrequency: dto.billingFrequency,
  manualBilling: false,
  interruptibleNoticePeriod: null,
  notes: null,
  dateAccepted: null,
  dateCreated: new Date('2026-09-01T00:00:00Z'),
  dateDeleted: null,
  dateUpdated: null,
  dateExpires: dto.dateExpires,
  organizationId: SUPPLIER_ORG,
  reservationId: null,
  listing: null,
};

describe('ReservationInvitesService.createReservationInviteAsASupplyCustomer', () => {
  const contextService = {
    requirePermission: vi.fn(),
    email: dto.inviterEmail,
    organizationId: SUPPLIER_ORG,
    requireIdentity: { organizationId: SUPPLIER_ORG },
  };
  const emailService = { send: { reservationInvite: vi.fn().mockResolvedValue(undefined) } };
  const gateBus = { runGate: vi.fn().mockResolvedValue(undefined) };

  let service: ReservationInvitesService;

  beforeEach(async () => {
    vi.clearAllMocks();
    gateBus.runGate.mockResolvedValue(undefined);
    vi.spyOn(InventoryRecord, 'findAvailableForInviteById').mockResolvedValue({
      server: { isInterruptible: false },
    } as never);
    vi.spyOn(ReservationInviteRecord, 'findDevicesByIds').mockResolvedValue([
      { id: DEVICE_ID, supplierId: SUPPLIER_ORG },
    ]);
    vi.spyOn(ReservationInviteRecord, 'createInviteWithDeviceLinks').mockResolvedValue({
      inviterEmail: dto.inviterEmail,
      inviteeEmail: dto.inviteeEmail,
      dateExpires: dto.dateExpires,
    } as never);
    vi.spyOn(ReservationInvitePresenter, 'toFullResponse').mockReturnValue(createdInvite);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReservationInvitesService,
        { provide: ContextService, useValue: contextService },
        { provide: EmailService, useValue: emailService },
        { provide: HostPluginGateBus, useValue: gateBus },
      ],
    }).compile();
    service = moduleRef.get(ReservationInvitesService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('authorizes the supplier before creating the invite', async () => {
    await expect(service.createReservationInviteAsASupplyCustomer(dto)).resolves.toEqual(createdInvite);

    expect(gateBus.runGate).toHaveBeenCalledWith('reservation.invite.authorize', {
      supplierOrganizationId: SUPPLIER_ORG,
    });
    expect(ReservationInviteRecord.createInviteWithDeviceLinks).toHaveBeenCalled();
    expect(emailService.send.reservationInvite).toHaveBeenCalled();
  });

  it('rejects Interruptible invite creates with the Reserved Rolling message', async () => {
    await expect(
      service.createReservationInviteAsASupplyCustomer({
        ...dto,
        contractType: ContractType.INTERRUPTIBLE,
        interruptibleNoticePeriod: 300_000,
      }),
    ).rejects.toMatchObject({
      response: {
        message: "This device isn't available for Interruptible contract type, please use Reserved Rolling",
      },
    });
    expect(ReservationInviteRecord.createInviteWithDeviceLinks).not.toHaveBeenCalled();
  });

  it('rejects On Demand invite creates with the Reserved Rolling message', async () => {
    await expect(
      service.createReservationInviteAsASupplyCustomer({
        ...dto,
        contractType: ContractType.ON_DEMAND,
      }),
    ).rejects.toMatchObject({
      response: {
        message: "This device isn't available for On Demand contract type, please use Reserved Rolling",
      },
    });
    expect(ReservationInviteRecord.createInviteWithDeviceLinks).not.toHaveBeenCalled();
  });

  it('rejects a notice period even when contractType is Reserved Rolling', async () => {
    await expect(
      service.createReservationInviteAsASupplyCustomer({
        ...dto,
        contractType: ContractType.RESERVED_ROLLING,
        interruptibleNoticePeriod: 300_000,
      }),
    ).rejects.toMatchObject({
      response: {
        message: expect.stringContaining('omit interruptibleNoticePeriod'),
      },
    });
    expect(ReservationInviteRecord.createInviteWithDeviceLinks).not.toHaveBeenCalled();
  });

  it('accepts Reserved Rolling invite creates', async () => {
    await expect(
      service.createReservationInviteAsASupplyCustomer({ ...dto, contractType: ContractType.RESERVED_ROLLING }),
    ).resolves.toEqual(createdInvite);
  });

  it('does not create the invite when the supplier is not billing-onboarded', async () => {
    gateBus.runGate.mockRejectedValue(
      new LifecycleGateRejection('Complete billing onboarding before creating reservation invites'),
    );

    await expect(service.createReservationInviteAsASupplyCustomer(dto)).rejects.toBeInstanceOf(LifecycleGateRejection);
    expect(ReservationInviteRecord.createInviteWithDeviceLinks).not.toHaveBeenCalled();
    expect(emailService.send.reservationInvite).not.toHaveBeenCalled();
  });

  it('propagates GateUnavailableError when the circuit breaker is open', async () => {
    gateBus.runGate.mockRejectedValue(new GateUnavailableError('reservation.invite.authorize', 'commerce'));

    await expect(service.createReservationInviteAsASupplyCustomer(dto)).rejects.toBeInstanceOf(GateUnavailableError);
    expect(ReservationInviteRecord.createInviteWithDeviceLinks).not.toHaveBeenCalled();
    expect(emailService.send.reservationInvite).not.toHaveBeenCalled();
  });

  it('does not run the billing gate when the devices are not the supplier', async () => {
    vi.mocked(ReservationInviteRecord.findDevicesByIds).mockResolvedValue([
      { id: DEVICE_ID, supplierId: 'other-org' },
    ]);

    await expect(service.createReservationInviteAsASupplyCustomer(dto)).rejects.toThrow(
      'Devices do not belong to supply organization',
    );
    expect(gateBus.runGate).not.toHaveBeenCalled();
    expect(ReservationInviteRecord.createInviteWithDeviceLinks).not.toHaveBeenCalled();
  });
});

describe('ReservationInvitesService.editReservationInviteAsASupplyCustomer', () => {
  const contextService = {
    requirePermission: vi.fn(),
    email: dto.inviterEmail,
    organizationId: SUPPLIER_ORG,
    requireIdentity: { organizationId: SUPPLIER_ORG },
  };
  const emailService = { send: { reservationInvite: vi.fn().mockResolvedValue(undefined) } };
  const gateBus = { runGate: vi.fn().mockResolvedValue(undefined) };

  let service: ReservationInvitesService;

  const activeAggregate = {
    id: 'invite-1',
    organizationId: SUPPLIER_ORG,
    inviteeEmail: dto.inviteeEmail,
    inviteeOrganizationId: null,
    inviterEmail: dto.inviterEmail,
    dateExpires: dto.dateExpires,
    dateAccepted: null,
    dateDeleted: null,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(ReservationInviteRecord, 'findAggregateByIdUnscoped').mockResolvedValue(activeAggregate as never);
    vi.spyOn(ReservationInvitePresenter, 'isActive').mockReturnValue(true);
    vi.spyOn(ReservationInviteRecord, 'findDevicesByIds').mockResolvedValue([
      { id: DEVICE_ID, supplierId: SUPPLIER_ORG },
    ]);
    vi.spyOn(ReservationInviteRecord, 'applyEditWithDeviceLinks').mockResolvedValue(activeAggregate as never);
    vi.spyOn(ReservationInvitePresenter, 'toFullResponse').mockReturnValue(createdInvite);

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReservationInvitesService,
        { provide: ContextService, useValue: contextService },
        { provide: EmailService, useValue: emailService },
        { provide: HostPluginGateBus, useValue: gateBus },
      ],
    }).compile();
    service = moduleRef.get(ReservationInvitesService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const editDto = {
    deviceIds: [DEVICE_ID],
    price: 200,
    billingFrequency: BillingFrequency.WEEKLY,
    dateExpires: new Date('2027-06-01T00:00:00Z'),
  };

  it('accepts Reserved Rolling invite edits', async () => {
    await expect(
      service.editReservationInviteAsASupplyCustomer('invite-1', {
        ...editDto,
        contractType: ContractType.RESERVED_ROLLING,
      }),
    ).resolves.toEqual(createdInvite);
    expect(ReservationInviteRecord.applyEditWithDeviceLinks).toHaveBeenCalled();
  });

  it('rejects On Demand invite edits with the Reserved Rolling message', async () => {
    await expect(
      service.editReservationInviteAsASupplyCustomer('invite-1', {
        ...editDto,
        contractType: ContractType.ON_DEMAND,
      }),
    ).rejects.toMatchObject({
      response: {
        message: "This device isn't available for On Demand contract type, please use Reserved Rolling",
      },
    });
    expect(ReservationInviteRecord.applyEditWithDeviceLinks).not.toHaveBeenCalled();
  });

  it('rejects Interruptible invite edits with the Reserved Rolling message', async () => {
    await expect(
      service.editReservationInviteAsASupplyCustomer('invite-1', {
        ...editDto,
        contractType: ContractType.INTERRUPTIBLE,
        interruptibleNoticePeriod: 300_000,
      }),
    ).rejects.toMatchObject({
      response: {
        message: "This device isn't available for Interruptible contract type, please use Reserved Rolling",
      },
    });
    expect(ReservationInviteRecord.applyEditWithDeviceLinks).not.toHaveBeenCalled();
  });

  it('rejects a notice period even when contractType is Reserved Rolling', async () => {
    await expect(
      service.editReservationInviteAsASupplyCustomer('invite-1', {
        ...editDto,
        contractType: ContractType.RESERVED_ROLLING,
        interruptibleNoticePeriod: 300_000,
      }),
    ).rejects.toMatchObject({
      response: {
        message: expect.stringContaining('omit interruptibleNoticePeriod'),
      },
    });
    expect(ReservationInviteRecord.applyEditWithDeviceLinks).not.toHaveBeenCalled();
  });
});
