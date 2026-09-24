import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BillingFrequency, LayerKind, RequestSource, StorageDriveType } from '@repo/database';
import { ContextService } from 'src/common/context/context.service';
import { DEPLOYMENTS_SERVICE } from 'src/deployments/deployments.tokens';
import { ProvisionValidatorService } from 'src/provision/processors';
import { ReservationProvisioningService } from 'src/reservations/reservation-provisioning.service';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleRepository } from '../lifecycle.repository';
import { ProvisionDispatcher } from '../operations/provision-dispatch';
import { ProvisionOperation, type ProvisionRequest } from '../operations/provision.operation';

const input: ProvisionRequest = {
  deviceId: 'device-1',
  userId: 'user-1',
  organizationId: 'org-1',
  deploymentName: 'my-box',
  operatingSystemSlug: 'ubuntu-22',
  sshKeyIds: ['key-1'],
  diskLayouts: [],
  cloudInit: null,
  ipxeUrl: null,
  customizations: null,
  source: RequestSource.API,
  tee: false,
  internalProvision: false,
  isInterruptible: false,
};

const raidLayout: ProvisionRequest['diskLayouts'][number] = {
  config: 'raid1',
  format: 'ext4',
  mountpoint: '/',
  diskType: 'NVMe',
  disks: ['nvme0n1', 'nvme1n1'],
  wipe: true,
};

const storageDrives = (secondType: StorageDriveType = StorageDriveType.NVME) => [
  {
    name: 'nvme0n1',
    type: StorageDriveType.NVME,
    sizeBytes: BigInt(1_000_000_000_000),
    model: 'Samsung PM9A3',
    serial: null,
    wwn: null,
  },
  {
    name: 'nvme1n1',
    type: secondType,
    sizeBytes: BigInt(1_000_000_000_000),
    model: 'Samsung PM9A3',
    serial: null,
    wwn: null,
  },
];

describe('ProvisionOperation', () => {
  const context = { organizationId: 'org-1', userId: 'user-1' };
  const repo = {
    fetchProvisionableDevice: vi.fn(),
    fetchSshPublicKeys: vi.fn().mockResolvedValue(['ssh-ed25519 AAA']),
    fetchStorageDrives: vi.fn().mockResolvedValue(storageDrives()),
  };
  const deploymentsService = { createDeployment: vi.fn().mockResolvedValue({ id: 'dep-1' }) };
  const provisionDispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };
  const reservationProvisioning = {
    createForProvision: vi.fn().mockResolvedValue('res-1'),
    acceptInviteForReservation: vi.fn().mockResolvedValue(false),
    resolveProvisionInviteFlags: vi.fn().mockResolvedValue({ fromInvite: false, manualBilling: false }),
    isKnownAccount: vi.fn().mockResolvedValue(false),
    billedLineForDeployment: vi.fn().mockResolvedValue({
      billingFrequency: BillingFrequency.WEEKLY,
      reservationPrice: 16_800,
      deviceName: 'box-1',
      deviceClass: 'H100',
      supplierOrganizationId: 'supplier-org-1',
    }),
  };

  let operation: ProvisionOperation;

  beforeEach(async () => {
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProvisionOperation,
        { provide: ContextService, useValue: context },
        { provide: LifecycleRepository, useValue: repo },
        { provide: DEPLOYMENTS_SERVICE, useValue: deploymentsService },
        { provide: ProvisionDispatcher, useValue: provisionDispatcher },
        ProvisionValidatorService,
        { provide: ReservationProvisioningService, useValue: reservationProvisioning },
        {
          provide: 'LoggerServiceProvisionOperation',
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();
    operation = moduleRef.get(ProvisionOperation);
  });

  describe('assembleContext', () => {
    it('validates and resolves the OS id + pubkeys', async () => {
      repo.fetchProvisionableDevice.mockResolvedValue({
        device: { supplierId: 'supplier-org-1', server: {}, storageDrives: [] },
        sshKeys: [{ id: 'key-1', key: 'ssh-ed25519 AAA' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.BASE },
      });

      await expect(operation.assembleContext(input)).resolves.toEqual({
        baseLayerId: 'layer-1',
        pubkeys: ['ssh-ed25519 AAA'],
        supplierOrganizationId: 'supplier-org-1',
      });
    });

    it('rejects a LEGACY OS layer (legacy bundles are no longer installable)', async () => {
      repo.fetchProvisionableDevice.mockResolvedValue({
        device: { server: {}, storageDrives: [] },
        sshKeys: [{ id: 'key-1', key: 'k' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.LEGACY },
      });

      await expect(operation.assembleContext(input)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an identity mismatch with the bound context', async () => {
      await expect(operation.assembleContext({ ...input, userId: 'someone-else' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repo.fetchProvisionableDevice).not.toHaveBeenCalled();
    });

    it('throws when the device is not provisionable', async () => {
      repo.fetchProvisionableDevice.mockResolvedValue({ device: null, sshKeys: [], baseLayer: null });
      await expect(operation.assembleContext(input)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the base layer is not found', async () => {
      repo.fetchProvisionableDevice.mockResolvedValue({
        device: { server: {}, storageDrives: [] },
        sshKeys: [{ id: 'key-1', key: 'ssh-ed25519 AAA' }],
        baseLayer: null,
      });
      await expect(operation.assembleContext(input)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the layer kind is not installable (not BASE)', async () => {
      repo.fetchProvisionableDevice.mockResolvedValue({
        device: { server: {}, storageDrives: [] },
        sshKeys: [{ id: 'key-1', key: 'k' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.COMPONENT },
      });
      await expect(operation.assembleContext(input)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a mixed RAID group before reservation creation', async () => {
      repo.fetchProvisionableDevice.mockResolvedValue({
        device: { server: {}, storageDrives: storageDrives(StorageDriveType.HDD) },
        sshKeys: [{ id: 'key-1', key: 'ssh-ed25519 AAA' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.BASE },
      });

      await expect(operation.assembleContext({ ...input, diskLayouts: [raidLayout] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(reservationProvisioning.createForProvision).not.toHaveBeenCalled();
    });

    it('accepts a homogeneous RAID group', async () => {
      repo.fetchProvisionableDevice.mockResolvedValue({
        device: { server: {}, storageDrives: storageDrives() },
        sshKeys: [{ id: 'key-1', key: 'ssh-ed25519 AAA' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.BASE },
      });

      await expect(operation.assembleContext({ ...input, diskLayouts: [raidLayout] })).resolves.toEqual({
        baseLayerId: 'layer-1',
        pubkeys: ['ssh-ed25519 AAA'],
        supplierOrganizationId: null,
      });
    });
  });

  describe('assembleContextForReplay', () => {
    it('resolves without the identity guard (replay has no request context)', async () => {
      repo.fetchProvisionableDevice.mockResolvedValue({
        device: { server: {}, storageDrives: [] },
        sshKeys: [{ id: 'key-1', key: 'ssh-ed25519 AAA' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.BASE },
      });

      await expect(
        operation.assembleContextForReplay({ ...input, userId: 'someone-else', organizationId: 'other-org' }),
      ).resolves.toEqual({
        baseLayerId: 'layer-1',
        pubkeys: ['ssh-ed25519 AAA'],
        supplierOrganizationId: null,
      });
    });

    it('propagates a non-null supplierId to the context', async () => {
      repo.fetchProvisionableDevice.mockResolvedValue({
        device: { supplierId: 'supplier-org-1', server: {}, storageDrives: [] },
        sshKeys: [{ id: 'key-1', key: 'ssh-ed25519 AAA' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.BASE },
      });

      await expect(
        operation.assembleContextForReplay({ ...input, userId: 'someone-else', organizationId: 'other-org' }),
      ).resolves.toEqual({
        baseLayerId: 'layer-1',
        pubkeys: ['ssh-ed25519 AAA'],
        supplierOrganizationId: 'supplier-org-1',
      });
    });
  });

  describe('assembleContextForResume', () => {
    it('reloads current storage drives and accepts a homogeneous RAID group', async () => {
      await expect(operation.assembleContextForResume({ ...input, diskLayouts: [raidLayout] })).resolves.toEqual({
        pubkeys: ['ssh-ed25519 AAA'],
      });
      expect(repo.fetchStorageDrives).toHaveBeenCalledWith('device-1');
    });

    it('rejects a RAID group that became heterogeneous during deferral', async () => {
      repo.fetchStorageDrives.mockResolvedValueOnce(storageDrives(StorageDriveType.HDD));

      await expect(
        operation.assembleContextForResume({ ...input, diskLayouts: [raidLayout] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('createReservation delegates to the reservation provisioning service', async () => {
    const id = await operation.createReservation(input);
    expect(id).toBe('res-1');
    expect(reservationProvisioning.createForProvision).toHaveBeenCalledWith({
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
      internalProvision: false,
      isInterruptible: false,
    });
  });

  it('acceptInvite delegates to the reservation provisioning service', async () => {
    await operation.acceptInvite('res-1');
    expect(reservationProvisioning.acceptInviteForReservation).toHaveBeenCalledWith('res-1');
  });

  it('acceptInvite swallows errors so a successful provision is never undone', async () => {
    reservationProvisioning.acceptInviteForReservation.mockRejectedValueOnce(new Error('boom'));
    await expect(operation.acceptInvite('res-1')).resolves.toBeUndefined();
  });

  it('resolveProvisionInviteFlags delegates to the reservation provisioning service', async () => {
    reservationProvisioning.resolveProvisionInviteFlags.mockResolvedValueOnce({
      fromInvite: true,
      manualBilling: true,
    });
    await expect(
      operation.resolveProvisionInviteFlags({ deviceId: 'device-1', userId: 'user-1', organizationId: 'org-1' }),
    ).resolves.toEqual({ fromInvite: true, manualBilling: true });
    expect(reservationProvisioning.resolveProvisionInviteFlags).toHaveBeenCalledWith({
      deviceId: 'device-1',
      userId: 'user-1',
      organizationId: 'org-1',
    });
  });

  it('billedLineForDeployment delegates to the reservation provisioning service', async () => {
    const line = {
      billingFrequency: BillingFrequency.MONTHLY,
      reservationPrice: 50_000,
      deviceName: 'box-1',
      deviceClass: 'H100',
      supplierOrganizationId: 'supplier-org-1',
    };
    reservationProvisioning.billedLineForDeployment.mockResolvedValueOnce(line);
    await expect(operation.billedLineForDeployment('dep-1')).resolves.toEqual(line);
    expect(reservationProvisioning.billedLineForDeployment).toHaveBeenCalledWith('dep-1');
  });

  it('createDeployment links the deployment to its reservation and returns its id', async () => {
    const id = await operation.createDeployment(input, 'layer-1', 'res-1');
    expect(id).toBe('dep-1');
    expect(deploymentsService.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        baseLayerId: 'layer-1',
        deployerId: 'user-1',
        customerId: 'org-1',
        reservationId: 'res-1',
      }),
    );
  });

  it('createDeployment marks a non-interruptible deployment with a null notice period', async () => {
    await operation.createDeployment(input, 'layer-1', 'res-1');
    expect(deploymentsService.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ isInterruptible: false, interruptibleNoticePeriod: null }),
    );
  });

  it('createDeployment marks an interruptible deployment with the supplied notice period', async () => {
    await operation.createDeployment(
      { ...input, isInterruptible: true, interruptibleNoticePeriod: 600_000 },
      'layer-1',
      'res-1',
    );
    expect(deploymentsService.createDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ isInterruptible: true, interruptibleNoticePeriod: 600_000 }),
    );
  });

  it('createDeployment defaults an interruptible notice period when none is supplied', async () => {
    await operation.createDeployment({ ...input, isInterruptible: true }, 'layer-1', 'res-1');
    const call = deploymentsService.createDeployment.mock.calls[0][0];
    expect(call.isInterruptible).toBe(true);
    expect(call.interruptibleNoticePeriod).toBeGreaterThan(0);
  });

  it('publish forwards to the shared provision dispatcher', async () => {
    await operation.publish(input, 'dep-1', ['k'], 'job-1');
    expect(provisionDispatcher.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        deviceId: 'device-1',
        jobId: 'job-1',
        deploymentId: 'dep-1',
        pubkeys: ['k'],
        status: 'provisioning',
      }),
    );
  });
});
