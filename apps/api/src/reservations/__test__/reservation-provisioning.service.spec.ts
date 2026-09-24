import { BillingFrequency, Prisma } from '@repo/database';
import { HOURS_IN_WEEK } from '@repo/utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ReservationInviteRecord } from '../invites/reservation-invite.record';
import { ReservationProvisioningService } from '../reservation-provisioning.service';

const baseInput = {
  deviceId: 'device-1',
  userId: 'user-1',
  organizationId: 'org-1',
  internalProvision: false,
  isInterruptible: false,
};

function makeService() {
  const prisma = {
    server: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    reservation: { findUnique: vi.fn() },
    deployment: { findUnique: vi.fn() },
    organization: { findUnique: vi.fn() },
  };
  const reservationsService = { createReservation: vi.fn().mockResolvedValue({ id: 'res-1' }) };
  const service = new ReservationProvisioningService(prisma as never, reservationsService as never);
  return { service, prisma, reservationsService };
}

function noInvite(prisma: ReturnType<typeof makeService>['prisma']) {
  prisma.server.findUnique.mockImplementation((args: { select: Record<string, unknown> }) =>
    'serversInReservationInvite' in args.select
      ? Promise.resolve({ serversInReservationInvite: [] })
      : Promise.resolve({ hourlyPrice: new Prisma.Decimal(100), floorHourlyPrice: new Prisma.Decimal(40) }),
  );
}

describe('ReservationProvisioningService.createForProvision', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('derives weekly pricing from the hourly rate when there is no invite', async () => {
    noInvite(ctx.prisma);

    await ctx.service.createForProvision(baseInput);

    const weekly = Math.round(100 * HOURS_IN_WEEK);
    expect(ctx.reservationsService.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        reserverId: 'user-1',
        customerId: 'org-1',
        deviceIds: ['device-1'],
        internalProvision: false,
        price: weekly,
        billingFrequency: BillingFrequency.WEEKLY,
        reservationInviteId: null,
      }),
    );
  });

  it('prices an interruptible rental off the floor hourly rate', async () => {
    noInvite(ctx.prisma);

    await ctx.service.createForProvision({ ...baseInput, isInterruptible: true });

    const weekly = Math.round(40 * HOURS_IN_WEEK);
    expect(ctx.reservationsService.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        price: weekly,
        interruptibleNoticePeriod: 300_000,
      }),
    );
  });

  it('leaves the notice period null for a non-interruptible direct rental', async () => {
    noInvite(ctx.prisma);

    await ctx.service.createForProvision(baseInput);

    expect(ctx.reservationsService.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ interruptibleNoticePeriod: null }),
    );
  });

  it('is free for an internal (SELF_PROVISION) provision', async () => {
    ctx.prisma.server.findUnique.mockResolvedValue({ serversInReservationInvite: [] });

    await ctx.service.createForProvision({ ...baseInput, internalProvision: true });

    expect(ctx.reservationsService.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ internalProvision: true, price: 0 }),
    );
  });

  it('lets an invite owned by the caller org override the pricing', async () => {
    ctx.prisma.server.findUnique.mockResolvedValue({
      serversInReservationInvite: [
        {
          reservationInvite: {
            id: 'invite-1',
            inviteeOrganizationId: 'org-1',
            inviteeEmail: null,
            price: 500,
            billingFrequency: BillingFrequency.MONTHLY,
            interruptibleNoticePeriod: 900_000,
            notes: 'agreed terms',
          },
        },
      ],
    });

    await ctx.service.createForProvision(baseInput);

    expect(ctx.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(ctx.reservationsService.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({
        price: 500,
        billingFrequency: BillingFrequency.MONTHLY,
        interruptibleNoticePeriod: 900_000,
        notes: 'agreed terms',
        reservationInviteId: 'invite-1',
      }),
    );
  });

  it('matches an invite by the caller email when the org does not match', async () => {
    ctx.prisma.server.findUnique.mockResolvedValue({
      serversInReservationInvite: [
        {
          reservationInvite: {
            id: 'invite-2',
            inviteeOrganizationId: 'other-org',
            inviteeEmail: 'buyer@example.com',
            price: 500,
            billingFrequency: BillingFrequency.MONTHLY,
            notes: null,
          },
        },
      ],
    });
    ctx.prisma.user.findUnique.mockResolvedValue({ email: 'buyer@example.com' });

    await ctx.service.createForProvision(baseInput);

    expect(ctx.reservationsService.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ reservationInviteId: 'invite-2', price: 500 }),
    );
  });

  it('ignores an invite that belongs to neither the caller org nor email', async () => {
    ctx.prisma.server.findUnique.mockImplementation((args: { select: Record<string, unknown> }) =>
      'serversInReservationInvite' in args.select
        ? Promise.resolve({
            serversInReservationInvite: [
              {
                reservationInvite: {
                  id: 'invite-3',
                  inviteeOrganizationId: 'other-org',
                  inviteeEmail: 'someone@else.com',
                  price: 500,
                },
              },
            ],
          })
        : Promise.resolve({ hourlyPrice: new Prisma.Decimal(100), floorHourlyPrice: null }),
    );
    ctx.prisma.user.findUnique.mockResolvedValue({ email: 'buyer@example.com' });

    await ctx.service.createForProvision(baseInput);

    expect(ctx.reservationsService.createReservation).toHaveBeenCalledWith(
      expect.objectContaining({ reservationInviteId: null, price: Math.round(100 * HOURS_IN_WEEK) }),
    );
  });

  it('throws when a non-invite, non-internal provision has no hourly price', async () => {
    ctx.prisma.server.findUnique.mockImplementation((args: { select: Record<string, unknown> }) =>
      'serversInReservationInvite' in args.select
        ? Promise.resolve({ serversInReservationInvite: [] })
        : Promise.resolve({ hourlyPrice: null, floorHourlyPrice: null }),
    );

    await expect(ctx.service.createForProvision(baseInput)).rejects.toThrow(/no hourly price/);
  });
});

describe('ReservationProvisioningService.acceptInviteForReservation', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
    vi.restoreAllMocks();
  });

  it('is a no-op for a direct reservation (no originating invite)', async () => {
    ctx.prisma.reservation.findUnique.mockResolvedValue({ reservationInvite: null });
    const acceptSpy = vi.spyOn(ReservationInviteRecord, 'acceptIfActiveUnscoped');

    await expect(ctx.service.acceptInviteForReservation('res-1')).resolves.toBe(false);
    expect(acceptSpy).not.toHaveBeenCalled();
  });

  it('atomically accepts the originating invite when the reservation was created from one', async () => {
    ctx.prisma.reservation.findUnique.mockResolvedValue({ reservationInvite: { id: 'invite-1' } });
    const acceptSpy = vi.spyOn(ReservationInviteRecord, 'acceptIfActiveUnscoped').mockResolvedValue(true);

    await expect(ctx.service.acceptInviteForReservation('res-1')).resolves.toBe(true);
    expect(acceptSpy).toHaveBeenCalledWith('invite-1');
  });
});

describe('ReservationProvisioningService.resolveProvisionInviteFlags', () => {
  let ctx: ReturnType<typeof makeService>;
  const inviteInput = { deviceId: 'device-1', userId: 'user-1', organizationId: 'org-1' };

  beforeEach(() => {
    ctx = makeService();
  });

  it('returns both flags false when there is no applicable invite', async () => {
    ctx.prisma.server.findUnique.mockResolvedValue({ serversInReservationInvite: [] });

    await expect(ctx.service.resolveProvisionInviteFlags(inviteInput)).resolves.toEqual({
      fromInvite: false,
      manualBilling: false,
    });
    expect(ctx.reservationsService.createReservation).not.toHaveBeenCalled();
  });

  it('returns fromInvite true and manualBilling true for a manual-billing org invite', async () => {
    ctx.prisma.server.findUnique.mockResolvedValue({
      serversInReservationInvite: [
        {
          reservationInvite: {
            id: 'invite-1',
            inviteeOrganizationId: 'org-1',
            inviteeEmail: null,
            manualBilling: true,
          },
        },
      ],
    });

    await expect(ctx.service.resolveProvisionInviteFlags(inviteInput)).resolves.toEqual({
      fromInvite: true,
      manualBilling: true,
    });
    expect(ctx.reservationsService.createReservation).not.toHaveBeenCalled();
  });

  it('returns fromInvite true and manualBilling false for an auto-billed org invite', async () => {
    ctx.prisma.server.findUnique.mockResolvedValue({
      serversInReservationInvite: [
        {
          reservationInvite: {
            id: 'invite-1',
            inviteeOrganizationId: 'org-1',
            inviteeEmail: null,
            manualBilling: false,
          },
        },
      ],
    });

    await expect(ctx.service.resolveProvisionInviteFlags(inviteInput)).resolves.toEqual({
      fromInvite: true,
      manualBilling: false,
    });
  });

  it('matches an invite by caller email when the org does not match', async () => {
    ctx.prisma.server.findUnique.mockResolvedValue({
      serversInReservationInvite: [
        {
          reservationInvite: {
            id: 'invite-2',
            inviteeOrganizationId: 'other-org',
            inviteeEmail: 'buyer@example.com',
            manualBilling: true,
          },
        },
      ],
    });
    ctx.prisma.user.findUnique.mockResolvedValue({ email: 'buyer@example.com' });

    await expect(ctx.service.resolveProvisionInviteFlags(inviteInput)).resolves.toEqual({
      fromInvite: true,
      manualBilling: true,
    });
  });
});

describe('ReservationProvisioningService.isKnownAccount', () => {
  let ctx: ReturnType<typeof makeService>;

  beforeEach(() => {
    ctx = makeService();
  });

  it('returns false when the organization is missing or not known', async () => {
    ctx.prisma.organization.findUnique.mockResolvedValue(null);
    await expect(ctx.service.isKnownAccount('org-1')).resolves.toBe(false);
    ctx.prisma.organization.findUnique.mockResolvedValue({ knownAccount: false });
    await expect(ctx.service.isKnownAccount('org-1')).resolves.toBe(false);
  });

  it('returns true when knownAccount is set', async () => {
    ctx.prisma.organization.findUnique.mockResolvedValue({ knownAccount: true });
    await expect(ctx.service.isKnownAccount('org-1')).resolves.toBe(true);
  });
});

describe('ReservationProvisioningService.billedLineForDeployment', () => {
  let ctx: ReturnType<typeof makeService>;
  beforeEach(() => {
    ctx = makeService();
  });

  it('maps reservation price, GPU model, and device supplier', async () => {
    ctx.prisma.deployment.findUnique.mockResolvedValue({
      reservation: { price: 50_000, billingFrequency: BillingFrequency.MONTHLY },
      server: {
        device: {
          id: 'device-1',
          name: 'box-1',
          supplierId: 'supplier-org-1',
          gpus: [{ model: 'H100' }],
        },
      },
    });

    await expect(ctx.service.billedLineForDeployment('dep-1')).resolves.toEqual({
      billingFrequency: BillingFrequency.MONTHLY,
      reservationPrice: 50_000,
      deviceName: 'box-1',
      deviceClass: 'H100',
      supplierOrganizationId: 'supplier-org-1',
    });
    expect(ctx.prisma.deployment.findUnique).toHaveBeenCalledWith({
      where: { id: 'dep-1' },
      select: {
        reservation: { select: { price: true, billingFrequency: true } },
        server: {
          select: {
            device: {
              select: {
                id: true,
                name: true,
                supplierId: true,
                gpus: { select: { model: true }, orderBy: { index: 'asc' }, take: 1 },
              },
            },
          },
        },
      },
    });
  });

  it('falls back to server class when GPU is missing', async () => {
    ctx.prisma.deployment.findUnique.mockResolvedValue({
      reservation: { price: null, billingFrequency: BillingFrequency.WEEKLY },
      server: { device: { id: 'device-1', name: 'box-1', supplierId: null, gpus: [] } },
    });

    await expect(ctx.service.billedLineForDeployment('dep-1')).resolves.toEqual({
      billingFrequency: BillingFrequency.WEEKLY,
      reservationPrice: null,
      deviceName: 'box-1',
      deviceClass: 'server',
      supplierOrganizationId: null,
    });
  });

  it('rejects when the deployment is missing', async () => {
    ctx.prisma.deployment.findUnique.mockResolvedValue(null);

    await expect(ctx.service.billedLineForDeployment('dep-1')).rejects.toThrow(
      'Deployment dep-1 not found for billed provision line',
    );
  });

  it('rejects when the deployment has no reservation cadence', async () => {
    ctx.prisma.deployment.findUnique.mockResolvedValue({
      reservation: null,
      server: { device: { id: 'device-1', name: 'box-1', supplierId: null, gpus: [] } },
    });

    await expect(ctx.service.billedLineForDeployment('dep-1')).rejects.toThrow(
      'Deployment dep-1 has no reservation billing frequency',
    );
  });
});
