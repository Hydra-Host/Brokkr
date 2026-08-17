import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { LayerKind, RequestSource, StorageDriveType } from '@repo/database';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { ProvisionValidatorService } from 'src/provision/processors';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleRepository } from '../lifecycle.repository';
import { ProvisionDispatcher } from '../operations/provision-dispatch';
import { ReprovisionOperation, type ReprovisionRequest } from '../operations/reprovision.operation';

type FindOne = typeof DeploymentRecord.findOneUnscoped;

const input: ReprovisionRequest = {
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
};

const raidLayout: ReprovisionRequest['diskLayouts'][number] = {
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

describe('ReprovisionOperation', () => {
  const repo = { fetchReprovisionableDevice: vi.fn() };
  const provisionDispatcher = { dispatch: vi.fn().mockResolvedValue(undefined) };

  let operation: ReprovisionOperation;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReprovisionOperation,
        { provide: LifecycleRepository, useValue: repo },
        { provide: ProvisionDispatcher, useValue: provisionDispatcher },
        ProvisionValidatorService,
      ],
    }).compile();
    operation = moduleRef.get(ReprovisionOperation);
  });

  describe('assembleContext', () => {
    it('validates and resolves the base layer, org, and pubkeys', async () => {
      repo.fetchReprovisionableDevice.mockResolvedValue({
        device: {
          storageDrives: [],
          server: {
            deployments: [{ customer: { id: 'org-1' } }],
          },
        },
        sshKeys: [{ id: 'key-1', key: 'ssh-ed25519 AAA' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.BASE },
      });

      await expect(operation.assembleContext(input)).resolves.toEqual({
        baseLayerId: 'layer-1',
        organizationId: 'org-1',
        pubkeys: ['ssh-ed25519 AAA'],
      });
    });

    it('rejects a LEGACY OS layer (legacy bundles are no longer installable)', async () => {
      repo.fetchReprovisionableDevice.mockResolvedValue({
        device: { server: { deployments: [{ customer: { id: 'org-1' } }] }, storageDrives: [] },
        sshKeys: [{ id: 'key-1', key: 'k' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.LEGACY },
      });

      await expect(operation.assembleContext(input)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws when the device is missing', async () => {
      repo.fetchReprovisionableDevice.mockResolvedValue({ device: null, sshKeys: [], baseLayer: null });
      await expect(operation.assembleContext(input)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the base layer is not found', async () => {
      repo.fetchReprovisionableDevice.mockResolvedValue({
        device: { server: { deployments: [{ customer: { id: 'org-1' } }] }, storageDrives: [] },
        sshKeys: [{ id: 'key-1', key: 'ssh-ed25519 AAA' }],
        baseLayer: null,
      });
      await expect(operation.assembleContext(input)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when an SSH key is missing', async () => {
      repo.fetchReprovisionableDevice.mockResolvedValue({
        device: { server: { deployments: [] }, storageDrives: [] },
        sshKeys: [],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.BASE },
      });
      await expect(operation.assembleContext(input)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws when the layer kind is not installable (not BASE)', async () => {
      repo.fetchReprovisionableDevice.mockResolvedValue({
        device: { server: { deployments: [] }, storageDrives: [] },
        sshKeys: [{ id: 'key-1', key: 'k' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.COMPONENT },
      });
      await expect(operation.assembleContext(input)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a mixed RAID group before deployment updates', async () => {
      const findOne = vi.spyOn(DeploymentRecord, 'findOneUnscoped');
      repo.fetchReprovisionableDevice.mockResolvedValue({
        device: {
          server: { deployments: [{ customer: { id: 'org-1' } }] },
          storageDrives: storageDrives(StorageDriveType.HDD),
        },
        sshKeys: [{ id: 'key-1', key: 'ssh-ed25519 AAA' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.BASE },
      });

      await expect(operation.assembleContext({ ...input, diskLayouts: [raidLayout] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(findOne).not.toHaveBeenCalled();
    });

    it('accepts a homogeneous RAID group', async () => {
      repo.fetchReprovisionableDevice.mockResolvedValue({
        device: {
          server: { deployments: [{ customer: { id: 'org-1' } }] },
          storageDrives: storageDrives(),
        },
        sshKeys: [{ id: 'key-1', key: 'ssh-ed25519 AAA' }],
        baseLayer: { id: 'layer-1', slug: 'ubuntu-22', kind: LayerKind.BASE },
      });

      await expect(operation.assembleContext({ ...input, diskLayouts: [raidLayout] })).resolves.toEqual({
        baseLayerId: 'layer-1',
        organizationId: 'org-1',
        pubkeys: ['ssh-ed25519 AAA'],
      });
    });
  });

  describe('dispatch', () => {
    it('updates the deployment then publishes the provision saga', async () => {
      const record = {
        updateBaseLayer: vi.fn().mockReturnThis(),
        rename: vi.fn().mockReturnThis(),
        updateCustomIpxeScript: vi.fn().mockReturnThis(),
        updateDiskEncryption: vi.fn().mockReturnThis(),
        save: vi.fn().mockResolvedValue(undefined),
        updateSshKeys: vi.fn().mockResolvedValue(undefined),
        data: { id: 'dep-1' },
      };
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
        record as unknown as Awaited<ReturnType<FindOne>>,
      );

      await operation.dispatch({
        input,
        organizationId: 'org-1',
        baseLayerId: 'layer-1',
        pubkeys: ['k'],
        jobId: 'job-1',
      });

      expect(record.updateBaseLayer).toHaveBeenCalledWith('layer-1');
      expect(record.rename).toHaveBeenCalledWith('my-box');
      expect(record.updateDiskEncryption).toHaveBeenCalledWith(false);
      expect(record.updateSshKeys).toHaveBeenCalledWith(['key-1']);
      expect(provisionDispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: 'device-1',
          jobId: 'job-1',
          deploymentId: 'dep-1',
          pubkeys: ['k'],
          status: 'reprovisioning',
        }),
      );
    });

    it('throws when there is no organization (no active deployment)', async () => {
      await expect(
        operation.dispatch({ input, organizationId: null, baseLayerId: 'layer-1', pubkeys: [], jobId: 'job-1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(provisionDispatcher.dispatch).not.toHaveBeenCalled();
    });
  });
});
