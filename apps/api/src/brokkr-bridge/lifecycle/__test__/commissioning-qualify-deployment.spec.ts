import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { LayerKind } from '@repo/database';
import { LayerRecord } from '@repo/layers';
import { PrismaClient } from 'src/prisma/prisma.client';
import { Mock, vi } from 'vitest';
import { DeviceContextService } from '../../device-context.service';
import { BridgeQueueService } from '../../queue/bridge-queue.service';
import type { StorageLayoutData } from '../../types/discovery-processors.types';
import { LifecyclePreparationService } from '../lifecycle-preparation.service';
import { BridgeCommissioningService } from '../commissioning.service';
import { BridgeProvisionService } from '../provision.service';

const DEVICE_ID = 'device-1';
const JOB_ID = 'job-1';

const STORAGE_LAYOUTS: StorageLayoutData = {
  configs: [
    {
      disk_group_name: 'ssd',
      disk_type: 'ssd',
      disks: [{ name: 'sda' }],
      capabilities: [],
      size_per_disk: 500,
      file_systems: ['ext4'],
      num_disks: 1,
    },
  ],
  default: {
    os_disks_group: { config: 'raid1', file_system: 'ext4', group: 'ssd', mountpoint: '/' },
    data_disks_groups: [],
    cold_storage_disks_groups: [],
  },
};

function makeDevice(overrides?: Partial<{ organizationId: string | null; zone: { organizationId: string } | null }>) {
  return {
    id: DEVICE_ID,
    organizationId: 'org-1',
    zone: { organizationId: 'org-1' },
    server: { id: 'server-1', storageLayouts: STORAGE_LAYOUTS },
    ...overrides,
  };
}

function noopLogger(): { log: Mock; warn: Mock; error: Mock; debug: Mock; verbose: Mock; setContext: Mock } {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn(), setContext: vi.fn() };
}

describe('BridgeCommissioningService — createQualifyDeployment guard paths', () => {
  let service: BridgeCommissioningService;
  let mockDeviceFindUnique: Mock;
  let mockOsFindUnique: Mock;
  let mockMemberFindMany: Mock;

  beforeEach(async () => {
    mockDeviceFindUnique = vi.fn();
    mockOsFindUnique = vi.fn();
    mockMemberFindMany = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeCommissioningService,
        {
          provide: PrismaClient,
          useValue: {
            device: { findUnique: mockDeviceFindUnique },
            operatingSystem: { findUnique: mockOsFindUnique },
            member: { findMany: mockMemberFindMany },
            job: { create: vi.fn().mockResolvedValue({ id: JOB_ID }) },
            deployment: { create: vi.fn().mockResolvedValue({ id: 'dep-1' }) },
          },
        },
        { provide: BridgeQueueService, useValue: {} },
        { provide: BridgeProvisionService, useValue: { provisionDevice: vi.fn().mockResolvedValue({}) } },
        { provide: LifecyclePreparationService, useValue: { prepareForProvision: vi.fn() } },
        { provide: DeviceContextService, useValue: {} },
        { provide: ConfigService, useValue: { get: vi.fn() } },
        { provide: `LoggerService${BridgeCommissioningService.name}`, useValue: noopLogger() },
      ],
    }).compile();

    service = module.get(BridgeCommissioningService);
  });

  const qualify = () => service.enqueueQualifyProvision(DEVICE_ID, JOB_ID, STORAGE_LAYOUTS);

  it('rejects when the Layer record is missing', async () => {
    mockDeviceFindUnique.mockResolvedValue(makeDevice());
    mockOsFindUnique.mockResolvedValue({ id: 'os-1' });
    vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(null);

    await expect(qualify()).rejects.toThrow(BadRequestException);
    await expect(qualify()).rejects.toThrow(/run seed-from-manifest/);
  });

  it('rejects when the Layer kind is not BASE or LEGACY', async () => {
    mockDeviceFindUnique.mockResolvedValue(makeDevice());
    mockOsFindUnique.mockResolvedValue({ id: 'os-1' });
    vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue({ id: 'layer-1', kind: LayerKind.LIVE } as any);

    await expect(qualify()).rejects.toThrow(BadRequestException);
    await expect(qualify()).rejects.toThrow(/not installable/);
  });

  it('rejects when the device has no owning organization', async () => {
    mockDeviceFindUnique.mockResolvedValue(makeDevice({ organizationId: null, zone: null }));
    mockOsFindUnique.mockResolvedValue({ id: 'os-1' });
    vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue({ id: 'layer-1', kind: LayerKind.BASE } as any);

    await expect(qualify()).rejects.toThrow(BadRequestException);
    await expect(qualify()).rejects.toThrow(/no owning organization/);
  });

  it('rejects when the organization has no owner-capable member', async () => {
    mockDeviceFindUnique.mockResolvedValue(makeDevice());
    mockOsFindUnique.mockResolvedValue({ id: 'os-1' });
    vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue({ id: 'layer-1', kind: LayerKind.BASE } as any);
    mockMemberFindMany.mockResolvedValue([]);

    await expect(qualify()).rejects.toThrow(BadRequestException);
    await expect(qualify()).rejects.toThrow(/no owner-capable member/);
    expect(mockMemberFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          organizationId: 'org-1',
          deletedAt: null,
          assignedRole: {
            rolePermissions: {
              some: {
                permission: { resource: 'organization', action: 'manage-owners' },
              },
            },
          },
        },
      }),
    );
  });

  it('rejects a prefiltered candidate that lacks the rest of the permission catalog', async () => {
    mockDeviceFindUnique.mockResolvedValue(makeDevice());
    mockOsFindUnique.mockResolvedValue({ id: 'os-1' });
    vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue({ id: 'layer-1', kind: LayerKind.BASE } as any);
    mockMemberFindMany.mockResolvedValue([
      {
        userId: 'user-1',
        assignedRole: {
          rolePermissions: [{ permission: { resource: 'organization', action: 'manage-owners' } }],
        },
      },
    ]);

    await expect(qualify()).rejects.toThrow(/no owner-capable member/);
  });
});
