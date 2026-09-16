import { BillingFrequency, Deployment, DeploymentType, Reservation, TeeCapability } from '@repo/database';
import { describe, expect, it } from 'vitest';
import {
  ServerSpecHelper,
  type DeploymentWithReservation,
  type InviteWithOrg,
  type ServerSpecsInput,
} from '../server-spec.helper';

function input(opts: {
  gpuModel?: string | null;
  serverTee?: boolean | null;
  serverCapable?: TeeCapability;
  legacyTee?: boolean;
}): ServerSpecsInput {
  const hasServer = opts.serverTee !== undefined || opts.serverCapable !== undefined;
  return {
    gpus: opts.gpuModel ? [{ model: opts.gpuModel }] : [],
    server: hasServer ? { teeEnabled: opts.serverTee ?? null, teeCapable: opts.serverCapable } : null,
    ...(opts.legacyTee !== undefined ? { teeEnabled: opts.legacyTee } : {}),
  } as unknown as ServerSpecsInput;
}

describe('ServerSpecHelper.teeEnabled', () => {
  it('returns true when the live Server flag is set', () => {
    expect(ServerSpecHelper.teeEnabled(input({ serverTee: true }))).toBe(true);
  });

  it('returns false when there is no Server row', () => {
    expect(ServerSpecHelper.teeEnabled(input({ serverTee: null }))).toBe(false);
  });

  it('ignores the archived Device column — the dropped fallback must not re-enable TEE', () => {
    expect(ServerSpecHelper.teeEnabled(input({ legacyTee: true }))).toBe(false);
    expect(ServerSpecHelper.teeEnabled(input({ serverTee: false, legacyTee: true }))).toBe(false);
  });
});

describe('ServerSpecHelper.isTeeCapable', () => {
  it('is true when capability is TRUE for a TEE-capable GPU', () => {
    expect(ServerSpecHelper.isTeeCapable(input({ gpuModel: 'NVIDIA H100', serverCapable: TeeCapability.TRUE }))).toBe(
      true,
    );
  });

  it('is false when capability is not TRUE (e.g. PATCH), even for a TEE-capable GPU', () => {
    expect(ServerSpecHelper.isTeeCapable(input({ gpuModel: 'NVIDIA H100', serverCapable: TeeCapability.PATCH }))).toBe(
      false,
    );
  });

  it('is false for a non-TEE GPU even when capability is TRUE', () => {
    expect(ServerSpecHelper.isTeeCapable(input({ gpuModel: 'NVIDIA A100', serverCapable: TeeCapability.TRUE }))).toBe(
      false,
    );
  });

  it('is true for a GPU-less host when capability is TRUE', () => {
    expect(ServerSpecHelper.isTeeCapable(input({ serverCapable: TeeCapability.TRUE }))).toBe(true);
  });

  it('is false for a GPU-less host when capability is PATCH', () => {
    expect(ServerSpecHelper.isTeeCapable(input({ serverCapable: TeeCapability.PATCH }))).toBe(false);
  });
});


function reservation(billingFrequency: BillingFrequency, price: number): Reservation {
  return {
    id: 'res-1',
    internalProvision: false,
    endDate: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: null,
    notes: null,
    price,
    billingFrequency,
    interruptibleNoticePeriod: null,
    reserverId: 'user-1',
    customerId: 'org-1',
  };
}

function deploymentWith(res: Reservation): DeploymentWithReservation {
  const deployment: Deployment = {
    id: 'dep-1',
    nickname: '',
    customIpxeScript: false,
    startDate: new Date('2026-01-01'),
    endDate: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: null,
    type: DeploymentType.SELF_SERVICE,
    serverId: 'srv-1',
    reservationId: res.id,
    scheduledInterruptionTime: null,
    isInterruptible: false,
    interruptibleNoticePeriod: null,
    isLocked: false,
    cloudInitStorageBlock: null,
    cloudInitNetworkBlock: null,
    cloudInitLateCommands: null,
    diskEncryptionEnabled: false,
    gpuDriversEnabled: false,
    publicIpAddressId: null,
    privateIpAddressId: null,
    deployerId: 'user-1',
    customerId: 'org-1',
    baseLayerId: null,
    rescueLayerId: null,
    deploymentProjectId: null,
  };
  return { ...deployment, reservation: res };
}

function invite(billingFrequency: BillingFrequency, price: number): InviteWithOrg {
  return {
    id: 'invite-1',
    inviteeEmail: 'buyer@example.com',
    inviterEmail: '',
    inviteeOrganizationId: null,
    price,
    billingFrequency,
    manualBilling: false,
    interruptibleNoticePeriod: null,
    notes: null,
    dateAccepted: null,
    dateCreated: new Date('2026-01-01'),
    dateDeleted: null,
    dateExpires: new Date('2027-01-01'),
    dateUpdated: null,
    organizationId: 'org-1',
    reservationId: null,
    inviteeOrganization: null,
  };
}

describe('ServerSpecHelper.reservationData', () => {
  it('derives per-hour rates for a WEEKLY cadence', () => {
    const data = ServerSpecHelper.reservationData(deploymentWith(reservation(BillingFrequency.WEEKLY, 33600)), 8);
    expect(data).toMatchObject({
      price: 33600,
      pricePerDeviceHour: 200,
      pricePerGpuHour: 25,
    });
  });

  it('returns null per-hour rates for an HOURLY cadence instead of dividing by zero', () => {
    const data = ServerSpecHelper.reservationData(deploymentWith(reservation(BillingFrequency.HOURLY, 33600)), 8);
    expect(data).toMatchObject({
      price: 33600,
      pricePerDeviceHour: null,
      pricePerGpuHour: null,
    });
  });
});

describe('ServerSpecHelper.reservationInviteData', () => {
  it('derives per-hour rates for a MONTHLY cadence', () => {
    const data = ServerSpecHelper.reservationInviteData(invite(BillingFrequency.MONTHLY, 74400), 4);
    expect(data).toMatchObject({
      price: 74400,
      pricePerDeviceHour: 100,
      pricePerGpuHour: 25,
    });
  });

  it('returns null per-hour rates for an HOURLY cadence instead of dividing by zero', () => {
    const data = ServerSpecHelper.reservationInviteData(invite(BillingFrequency.HOURLY, 74400), 4);
    expect(data).toMatchObject({
      price: 74400,
      pricePerDeviceHour: null,
      pricePerGpuHour: null,
    });
  });
});
