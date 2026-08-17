import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import { LayerKind } from '@repo/database';
import { MAIN_APP_PERMISSIONS } from 'src/permissions/permissions.constants';
import { PrismaClient } from 'src/prisma/prisma.client';
import { Mock, vi } from 'vitest';
import { DeviceContextService } from '../../device-context.service';
import { BridgeQueueService } from '../../queue/bridge-queue.service';
import { LifecyclePreparationService } from '../lifecycle-preparation.service';
import { BridgeCommissioningService } from '../commissioning.service';
import { BridgeProvisionService } from '../provision.service';

const DEVICE_ID = 'device-1';
const JOB_ID = 'job-1';
const ORG_ID = 'org-1';
const OWNER_USER_ID = 'user-owner-1';
const OS_SLUG = 'ubuntu-24.04';

function makeDevice() {
  return {
    id: DEVICE_ID,
    organizationId: ORG_ID,
    zone: { organizationId: ORG_ID },
    server: {
      id: 'server-1',
      storageLayouts: {
        configs: [
          {
            disk_group_name: 'nvme',
            disk_type: 'nvme',
            size_per_disk: 500,
            disks: [{ wwn: '0x500a', serial: 'S1', name: 'nvme0n1' }],
          },
        ],
      },
    },
  };
}

describe('BridgeCommissioningService.enqueueQualifyProvision', () => {
  let service: BridgeCommissioningService;
  let mockLayerFindUnique: Mock;
  let mockPrisma: {
    device: { findUnique: Mock };
    job: { create: Mock };
    member: { findMany: Mock };
    deployment: { create: Mock };
  };
  let mockProvisionService: { provisionDevice: Mock };
  let mockLifecyclePrep: { prepareForProvision: Mock };
  let mockLogger: { log: Mock; warn: Mock; error: Mock; debug: Mock; verbose: Mock; setContext: Mock };

  beforeEach(async () => {
    mockLayerFindUnique = vi.fn();

    ActiveRecordRegistry.configureForTest({
      layer: { findUnique: mockLayerFindUnique },
    });

    mockPrisma = {
      device: { findUnique: vi.fn() },
      job: { create: vi.fn().mockResolvedValue({ id: JOB_ID }) },
      member: { findMany: vi.fn() },
      deployment: { create: vi.fn() },
    };

    mockProvisionService = {
      provisionDevice: vi.fn().mockResolvedValue({ success: true }),
    };

    mockLifecyclePrep = {
      prepareForProvision: vi.fn().mockResolvedValue(undefined),
    };

    mockLogger = {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
      setContext: vi.fn().mockReturnThis(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeCommissioningService,
        { provide: BridgeQueueService, useValue: { enqueueSagaJob: vi.fn() } },
        { provide: BridgeProvisionService, useValue: mockProvisionService },
        { provide: LifecyclePreparationService, useValue: mockLifecyclePrep },
        { provide: DeviceContextService, useValue: { resolve: vi.fn() } },
        { provide: PrismaClient, useValue: mockPrisma },
        { provide: ConfigService, useValue: { get: vi.fn() } },
        { provide: `LoggerService${BridgeCommissioningService.name}`, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<BridgeCommissioningService>(BridgeCommissioningService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a LEGACY OS layer with BadRequestException', async () => {
    mockPrisma.device.findUnique.mockResolvedValueOnce(makeDevice());
    mockLayerFindUnique.mockResolvedValueOnce({
      id: 'layer-legacy',
      slug: OS_SLUG,
      kind: LayerKind.LEGACY,
    });

    const error = await service.enqueueQualifyProvision(DEVICE_ID, JOB_ID).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error).toMatchObject({ message: expect.stringMatching(/is not installable/) });
    expect(mockPrisma.job.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.deployment.create).not.toHaveBeenCalled();
  });

  it('creates a deployment when the layer is kind=BASE', async () => {
    const deploymentId = 'dep-1';
    mockPrisma.device.findUnique.mockResolvedValueOnce(makeDevice());
    mockLayerFindUnique.mockResolvedValueOnce({
      id: 'layer-base',
      slug: OS_SLUG,
      kind: LayerKind.BASE,
    });
    mockPrisma.member.findMany.mockResolvedValueOnce([
      {
        userId: OWNER_USER_ID,
        assignedRole: {
          rolePermissions: MAIN_APP_PERMISSIONS.map(({ resource, action }) => ({
            permission: { resource, action },
          })),
        },
      },
    ]);
    mockPrisma.deployment.create.mockResolvedValueOnce({ id: deploymentId });

    await service.enqueueQualifyProvision(DEVICE_ID, JOB_ID);

    expect(mockPrisma.member.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: ORG_ID,
        deletedAt: null,
        assignedRole: {
          rolePermissions: {
            some: {
              permission: { resource: 'organization', action: 'manage-owners' },
            },
          },
        },
      },
      select: {
        userId: true,
        assignedRole: {
          select: {
            rolePermissions: {
              select: { permission: { select: { resource: true, action: true } } },
            },
          },
        },
      },
    });
    expect(mockPrisma.deployment.create).toHaveBeenCalledTimes(1);
    expect(mockProvisionService.provisionDevice).toHaveBeenCalledWith(
      DEVICE_ID,
      JOB_ID,
      'provisioning',
      expect.objectContaining({ hostname: `commission-test-${DEVICE_ID}` }),
      OS_SLUG,
      deploymentId,
    );
  });
});
