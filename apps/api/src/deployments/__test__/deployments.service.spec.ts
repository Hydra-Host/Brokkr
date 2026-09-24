import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import type { OperatingSystemSlug, ReprovisionDiskLayout } from '@repo/api-client';
import { DeploymentType, InterruptibleClaimStatus, JobType, RequestSource, TeeCapability } from '@repo/database';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { randomUUID } from 'crypto';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { DeviceRecordPublisher } from 'src/brokkr-bridge/device-record/device-record-publisher.service';
import { BridgePowerControlService } from 'src/brokkr-bridge/lifecycle/power-control.service';
import { ServerTokenService } from 'src/brokkr-bridge/server-token/server-token.service';
import { SolLogService } from 'src/brokkr-bridge/sol-logs/sol-log.service';
import { CloudInitTemplatesService } from 'src/cloud-init-templates/cloud-init-templates.service';
import { ContextService } from 'src/common/context/context.service';
import { createLoggerMock, createLoggerProvidersForTest } from 'src/common/logger-test-utils';
import { ConfigAtomWriter } from 'src/common/redis/config-atom-writer.service';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { LifecycleService } from 'src/lifecycle/lifecycle.service';
import {
  mockDeployment,
  mockDeploymentLifecycleActionWithUser,
  mockDevice,
  mockDeviceMetadata,
  mockReservation,
  mockSshKeys,
  mockSupplyOrganization,
  mockSupplyOrganizationMembership,
  mockUbuntuRescueOS,
  mockUser,
} from 'src/prisma/fixtures';
import { PrismaClient } from 'src/prisma/prisma.client';
import { CloudInitProcessor, ProvisionValidatorService } from 'src/provision/processors';
import { WebhookDeliveryService } from 'src/webhook/webhook-delivery.service';
import { WebhookRepository } from 'src/webhook/webhook.repository';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DeploymentProjectRecord } from '../deployment-project.record';
import { DeploymentPresenter } from '../deployment.presenter';
import { DeploymentRecord } from '../deployment.record';
import { RescueModeService } from '../rescue-mode.service';
import { DeploymentsService } from '../services/deployments.service';
import { DeploymentAggregate } from '../types/deployments.types';
import { createMockDeploymentAggregate } from './fixtures';

vi.mock('@repo/layers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@repo/layers')>()),
  buildCustomizationCatalog: vi.fn(async () => ({ bases: [], componentsByBase: {} })),
  resolveZoneBuildId: vi.fn(async () => null),
}));

import { buildCustomizationCatalog, LayerRecord, resolveZoneBuildId } from '@repo/layers';

function createMockRecord(data: Record<string, unknown> = {}) {
  return {
    data: {
      id: mockDeployment.id,
      isLocked: false,
      deviceId: mockDevice.id,
      ...data,
    },
    save: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockReturnThis(),
    lock: vi.fn().mockReturnThis(),
    unlock: vi.fn().mockReturnThis(),
    toggleLock: vi.fn().mockImplementation(function (this: any) {
      this.data.isLocked = !this.data.isLocked;
      return this;
    }),
    endDeployment: vi.fn().mockReturnThis(),
    setScheduledInterruptionTime: vi.fn().mockReturnThis(),
    updateBaseLayer: vi.fn().mockReturnThis(),
    updateCustomIpxeScript: vi.fn().mockReturnThis(),
    updateSshKeys: vi.fn().mockResolvedValue(undefined),
    setRescueLayer: vi.fn().mockReturnThis(),
    isDirty: false,
    state: 'persisted',
  };
}

describe('DeploymentsService', () => {
  let service: DeploymentsService;
  let mockContextService: ContextService;
  let mockServerTokenWrite: Mock;
  let mockRebootDevice: Mock;
  let mockDeviceRecordWrite: Mock;
  let mockResolveZoneContext: Mock;
  let mockConfigAtomSetString: Mock;
  let mockConfigAtomDelKey: Mock;
  let mockLoggerWarn: Mock;
  let mockLoggerLog: Mock;
  let mockLoggerError: Mock;

  const mockLifecycleService: {
    requestReboot: Mock;
    requestPowerControl: Mock;
    requestDeprovision: Mock;
    requestReprovision: Mock;
  } = {
    requestReboot: vi.fn(),
    requestPowerControl: vi.fn(),
    requestDeprovision: vi.fn(),
    requestReprovision: vi.fn(),
  };

  const mockSolLogService = {
    getLogsForPlan: vi.fn(),
  };

  const mockWebhookDeliveryService = {
    scheduleDelivery: vi.fn().mockResolvedValue({}),
  };

  const mockWebhookRepository = {
    findMany: vi.fn().mockResolvedValue([]),
  };

  const mockPrismaClient = {
    job: {
      findMany: vi.fn(),
    },
    interruptibleClaim: {
      findMany: vi.fn(),
    },
  };

  const mockDeploymentKeys = mockSshKeys.map((key) => ({
    id: key.id,
    sshKeyId: key.id,
    deploymentId: mockDeployment.id,
    sshKey: {
      ...key,
      user: {
        ...mockUser,
        members: [mockSupplyOrganizationMembership],
      },
    },
  })) as DeploymentAggregate['deploymentKeys'];

  const mockCloudInitProcessor = {
    process: vi.fn().mockReturnValue(null),
    parseYaml: vi.fn(),
    encodeToBase64: vi.fn(),
  };

  const mockProvisionValidatorService: {
    validateMountpoint: Mock;
    validateDiskLayouts: Mock;
    validateDiskGroupHomogeneity: Mock;
    validateDiskGroupSizeLimits: Mock;
    validate: Mock;
    validateIpxeRequirements: Mock;
    validateCustomizations: Mock;
  } = {
    validateMountpoint: vi.fn(),
    validateDiskLayouts: vi.fn(),
    validateDiskGroupHomogeneity: vi.fn(),
    validateDiskGroupSizeLimits: vi.fn(),
    validate: vi.fn(),
    validateIpxeRequirements: vi.fn(),
    validateCustomizations: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    ActiveRecordRegistry.configureForTest({ deployment: {}, deploymentLifecycleAction: {}, deploymentProject: {} });

    mockServerTokenWrite = vi.fn().mockResolvedValue({ cipher: 'c', signature: 's' });
    mockRebootDevice = vi.fn().mockResolvedValue(undefined);
    mockDeviceRecordWrite = vi.fn().mockResolvedValue({ written: true });
    mockResolveZoneContext = vi.fn().mockResolvedValue({ zoneId: 'zone-1' });
    mockConfigAtomSetString = vi.fn().mockResolvedValue(undefined);
    mockConfigAtomDelKey = vi.fn().mockResolvedValue(undefined);

    mockContextService = {
      get organizationId() {
        return mockSupplyOrganization.id;
      },
      get userId() {
        return mockUser.id;
      },
      get requestSource() {
        return RequestSource.UI;
      },
      get requireRequestId() {
        return 'test-request-id';
      },
      requirePermission: vi.fn(),
    } as unknown as ContextService;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DeploymentsService,
        RescueModeService,
        { provide: PrismaClient, useValue: mockPrismaClient },
        { provide: LifecycleService, useValue: mockLifecycleService },
        { provide: SolLogService, useValue: mockSolLogService },
        { provide: WebhookDeliveryService, useValue: mockWebhookDeliveryService },
        { provide: WebhookRepository, useValue: mockWebhookRepository },
        { provide: BridgePowerControlService, useValue: { rebootDevice: mockRebootDevice } },
        { provide: ServerTokenService, useValue: { writeForDeviceBestEffort: mockServerTokenWrite } },
        { provide: DeviceRecordPublisher, useValue: { writeForDevice: mockDeviceRecordWrite } },
        { provide: DeviceContextService, useValue: { resolveZoneContext: mockResolveZoneContext } },
        {
          provide: ConfigAtomWriter,
          useValue: { setString: mockConfigAtomSetString, delKey: mockConfigAtomDelKey },
        },
        { provide: ContextService, useValue: mockContextService },
        { provide: CloudInitProcessor, useValue: mockCloudInitProcessor },
        { provide: ProvisionValidatorService, useValue: mockProvisionValidatorService },
        {
          provide: CloudInitTemplatesService,
          useValue: {
            resolveAndSave: vi
              .fn()
              .mockImplementation((p: { cloudInit?: unknown }) => Promise.resolve(p.cloudInit ?? null)),
          },
        },
        { provide: 'LoggerServiceRescueModeService', useValue: createLoggerMock() },
        ...createLoggerProvidersForTest(),
      ],
    }).compile();

    service = module.get<DeploymentsService>(DeploymentsService);

    const deploymentsLogger = module.get<{ warn: Mock; log: Mock; error: Mock }>('LoggerServiceDeploymentsService');
    const rescueLogger = module.get<{ warn: Mock; log: Mock; error: Mock }>('LoggerServiceRescueModeService');
    mockLoggerWarn = rescueLogger.warn;
    mockLoggerLog = rescueLogger.log;
    mockLoggerError = deploymentsLogger.error;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createDeployment', () => {
    const baseCreateData = {
      nickname: 'Test Deployment',
      customIpxeScript: false,
      sshKeyIds: mockSshKeys.map((sshKey) => sshKey.id),
      deviceId: mockDevice.id,
      baseLayerId: 'layer-123',
      deployerId: mockUser.id,
      customerId: mockSupplyOrganization.id,
      type: DeploymentType.SELF_SERVICE,
      reservationId: mockReservation.id,
      source: RequestSource.UI,
    };

    it("threads the org's existing default project id into the deployment", async () => {
      const createSpy = vi.spyOn(DeploymentRecord, 'createWithRelations').mockResolvedValue({} as any);
      vi.spyOn(DeploymentProjectRecord, 'findActiveDefaultUnscoped').mockResolvedValue({
        id: 'default-project-123',
      } as any);

      await service.createDeployment(baseCreateData);

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ...baseCreateData,
          projectId: 'default-project-123',
        }),
      );
    });

    it('auto-creates a default project for the org when none exists and threads its id', async () => {
      const createSpy = vi.spyOn(DeploymentRecord, 'createWithRelations').mockResolvedValue({} as any);
      vi.spyOn(DeploymentProjectRecord, 'findActiveDefaultUnscoped').mockResolvedValue(null as any);
      const createProjectSpy = vi.spyOn(DeploymentProjectRecord, 'createWithRelations').mockResolvedValue({
        id: 'auto-created-project-456',
      } as any);

      await service.createDeployment(baseCreateData);

      expect(createProjectSpy).toHaveBeenCalledWith({
        name: 'Default Project',
        isDefault: true,
        organizationId: baseCreateData.customerId,
      });
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ...baseCreateData,
          projectId: 'auto-created-project-456',
        }),
      );
    });

    it('uses an explicitly supplied projectId after verifying it belongs to the org', async () => {
      const createSpy = vi.spyOn(DeploymentRecord, 'createWithRelations').mockResolvedValue({} as any);
      const findDefaultSpy = vi.spyOn(DeploymentProjectRecord, 'findActiveDefaultUnscoped');
      const createProjectSpy = vi.spyOn(DeploymentProjectRecord, 'createWithRelations');
      const ownershipSpy = vi
        .spyOn(DeploymentProjectRecord, 'findActiveByIdUnscoped')
        .mockResolvedValue({ id: 'explicit-project-789' } as any);

      const createData = { ...baseCreateData, projectId: 'explicit-project-789' };
      await service.createDeployment(createData);

      expect(ownershipSpy).toHaveBeenCalledWith('explicit-project-789', baseCreateData.customerId);
      expect(findDefaultSpy).not.toHaveBeenCalled();
      expect(createProjectSpy).not.toHaveBeenCalled();
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          ...createData,
          projectId: 'explicit-project-789',
        }),
      );
    });

    it('rejects a supplied projectId that belongs to another organization', async () => {
      const createSpy = vi.spyOn(DeploymentRecord, 'createWithRelations').mockResolvedValue({} as any);
      vi.spyOn(DeploymentProjectRecord, 'findActiveByIdUnscoped').mockResolvedValue(null as any);

      const createData = { ...baseCreateData, projectId: 'foreign-project-000' };

      await expect(service.createDeployment(createData)).rejects.toBeInstanceOf(NotFoundException);
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe('getDeploymentByDeviceId', () => {
    it('should return aggregate for authorized user', async () => {
      const mockAggregate = { id: 'dep-1' } as any;
      vi.spyOn(DeploymentRecord, 'findAggregateByDeviceId').mockResolvedValue(mockAggregate);

      const result = await service.getDeploymentByDeviceId('device-uuid-1');
      expect(result).toBe(mockAggregate);
    });

    it('should throw NotFoundException when not found', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateByDeviceId').mockResolvedValue(null);
      await expect(service.getDeploymentByDeviceId('device-uuid-1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getDeploymentById', () => {
    const aggregateWithDevice = { server: { device: {}, teeEnabled: false } } as any;

    it('presents undefined OS names when baseLayer and rescueLayer are null', async () => {
      const nullLayerAggregate = createMockDeploymentAggregate({
        baseLayerId: null,
        baseLayer: null,
        rescueLayerId: null,
        rescueLayer: null,
        lifecycleActions: [mockDeploymentLifecycleActionWithUser],
      });

      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(nullLayerAggregate);
      const result = await service.getDeploymentById('dep-1');

      expect(result.specs.operating_system).toBeUndefined();
      expect(result.specs.current_rescue_operating_system_name).toBeUndefined();
    });

    it('derives operating_system from baseLayer name', async () => {
      const aggregate = createMockDeploymentAggregate({
        baseLayer: {
          id: 'layer-new',
          slug: 'ubuntu-24.04',
          name: 'Ubuntu 24.04',
          family: 'base',
          kind: 'BASE',
          layerGroupId: 'group-123',
          createdAt: new Date('2023-01-01'),
          updatedAt: new Date('2023-01-01'),
        },
        lifecycleActions: [mockDeploymentLifecycleActionWithUser],
      });

      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      const result = await service.getDeploymentById('dep-1');

      expect(result.specs.operating_system).toBe('Ubuntu 24.04');
    });

    it('passes the hydrated catalog to the presenter', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregateWithDevice);
      const presenterSpy = vi.spyOn(DeploymentPresenter, 'toResponse').mockReturnValue({ id: 'formatted' } as any);

      const result = await service.getDeploymentById('dep-1');

      expect(result).toEqual({ id: 'formatted' });
      expect(presenterSpy).toHaveBeenCalledWith(aggregateWithDevice, { bases: [], componentsByBase: {} });
    });

    it('fails soft to an empty catalog when hydration throws (detail read must not 500)', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregateWithDevice);
      const presenterSpy = vi.spyOn(DeploymentPresenter, 'toResponse').mockReturnValue({ id: 'formatted' } as any);
      vi.mocked(buildCustomizationCatalog).mockRejectedValueOnce(new Error('layer table unavailable'));

      const result = await service.getDeploymentById('dep-1');

      expect(result).toEqual({ id: 'formatted' });
      expect(presenterSpy).toHaveBeenCalledWith(aggregateWithDevice, { bases: [], componentsByBase: {} });
      expect(mockLoggerError).toHaveBeenCalled();
    });

    it('propagates ConflictException from resolveZoneBuildId (business error, not fail-soft)', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregateWithDevice);
      vi.mocked(resolveZoneBuildId).mockRejectedValueOnce(new ConflictException('no ready build'));

      await expect(service.getDeploymentById('dep-1')).rejects.toThrow(ConflictException);
    });
  });

  describe('getDeploymentsForOrganizations', () => {
    it('should return presenter-formatted deployments', async () => {
      const mockAggregate = {
        ...mockDeployment,
        deploymentKeys: mockDeploymentKeys,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
        deployer: mockUser,
        customer: mockSupplyOrganization,
        reservation: mockReservation,
        lifecycleActions: [mockDeploymentLifecycleActionWithUser],
        lifecycleRequests: [],
        deviceDiagnostics: [],
        deploymentProject: {
          id: 'p-1',
          name: 'P',
          isDefault: false,
          organizationId: 'o',
          createdAt: new Date(),
          updatedAt: new Date(),
          deletedAt: null,
        },
      } as any;

      vi.spyOn(DeploymentRecord, 'findActiveAggregatesForCaller').mockResolvedValue([mockAggregate]);
      const presenterSpy = vi.spyOn(DeploymentPresenter, 'toResponse').mockReturnValue({ id: 'formatted' } as any);

      const result = await service.getDeploymentsForOrganizations({});

      expect(result.data).toHaveLength(1);
      expect(presenterSpy).toHaveBeenCalledWith(mockAggregate);
    });
  });

  describe('getLogsForDeploymentJob', () => {
    const aggregate = createMockDeploymentAggregate({ customIpxeScript: true });
    let findOneUnscoped: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      mockSolLogService.getLogsForPlan.mockReset();
      mockPrismaClient.job.findMany.mockReset();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      findOneUnscoped = vi.spyOn(LifecycleJobRecord, 'findOneUnscoped').mockResolvedValue(null);
    });

    it('reads SOL logs from Redis using the zone prefix and the newest lifecycle job of the deployment', async () => {
      const latestJobId = randomUUID();
      findOneUnscoped.mockResolvedValue({ data: { id: latestJobId } });
      mockSolLogService.getLogsForPlan.mockResolvedValue({
        entries: [{ timestamp: '2026-05-30T00:00:00.000', message: 'booting' }],
        complete: false,
      });

      const result = await service.getLogsForDeploymentJob({
        deploymentId: aggregate.id,
        jobType: JobType.Provision,
      });

      expect(findOneUnscoped).toHaveBeenCalledWith({
        where: { deploymentId: aggregate.id, jobType: JobType.Provision },
        orderBy: { createdAt: 'desc' },
      });
      expect(mockResolveZoneContext).toHaveBeenCalledWith(aggregate.server.device.id);
      expect(mockSolLogService.getLogsForPlan).toHaveBeenCalledWith('zone-1', latestJobId);
      expect(result).toEqual({
        success: true,
        message: 'SOL log streaming in progress',
        entries: [{ timestamp: '2026-05-30T00:00:00.000', message: 'booting' }],
        complete: false,
      });
    });

    it('reports streaming complete when the bridge sentinel has landed', async () => {
      findOneUnscoped.mockResolvedValue({ data: { id: randomUUID() } });
      mockSolLogService.getLogsForPlan.mockResolvedValue({
        entries: [
          { timestamp: '2026-05-30T00:00:00.000', message: 'booting' },
          { timestamp: '2026-05-30T00:00:01.000', message: 'END LOG COLLECTION' },
        ],
        complete: true,
      });

      const result = await service.getLogsForDeploymentJob({
        deploymentId: aggregate.id,
        jobType: JobType.Provision,
      });

      expect(result.complete).toBe(true);
      expect(result.message).toBe('SOL log streaming complete');
    });

    it('throws NotFoundException when deployment not found', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(null);
      await expect(
        service.getLogsForDeploymentJob({ deploymentId: aggregate.id, jobType: JobType.Provision }),
      ).rejects.toThrow(NotFoundException);
      expect(findOneUnscoped).not.toHaveBeenCalled();
    });

    it('returns the log when the deployment did not use a custom iPXE script', async () => {
      const latestJobId = randomUUID();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(
        createMockDeploymentAggregate({ customIpxeScript: false }),
      );
      findOneUnscoped.mockResolvedValue({ data: { id: latestJobId } });
      mockSolLogService.getLogsForPlan.mockResolvedValue({ entries: [], complete: false });

      const result = await service.getLogsForDeploymentJob({
        deploymentId: aggregate.id,
        jobType: JobType.Provision,
      });

      expect(mockSolLogService.getLogsForPlan).toHaveBeenCalledWith('zone-1', latestJobId);
      expect(result.success).toBe(true);
    });

    it('throws NotFoundException when the deployment has no lifecycle job of that type', async () => {
      await expect(
        service.getLogsForDeploymentJob({ deploymentId: aggregate.id, jobType: JobType.Provision }),
      ).rejects.toThrow(new NotFoundException('No jobs found for deployment'));
      expect(mockSolLogService.getLogsForPlan).not.toHaveBeenCalled();
    });

    it('ignores a legacy device-keyed job row and reports no jobs for the deployment', async () => {
      mockPrismaClient.job.findMany.mockResolvedValue([
        {
          id: randomUUID(),
          jobType: JobType.Provision,
          deviceId: aggregate.server.device.id,
          createdAt: new Date(),
        },
      ]);

      await expect(
        service.getLogsForDeploymentJob({ deploymentId: aggregate.id, jobType: JobType.Provision }),
      ).rejects.toThrow(new NotFoundException('No jobs found for deployment'));
      expect(mockPrismaClient.job.findMany).not.toHaveBeenCalled();
      expect(mockSolLogService.getLogsForPlan).not.toHaveBeenCalled();
    });

    it('resolves a deprovision log through the lifecycle job of the deployment', async () => {
      const latestJobId = randomUUID();
      findOneUnscoped.mockResolvedValue({ data: { id: latestJobId } });
      mockSolLogService.getLogsForPlan.mockResolvedValue({ entries: [], complete: true });

      const result = await service.getLogsForDeploymentJob({
        deploymentId: aggregate.id,
        jobType: JobType.Deprovision,
      });

      expect(findOneUnscoped).toHaveBeenCalledWith({
        where: { deploymentId: aggregate.id, jobType: JobType.Deprovision },
        orderBy: { createdAt: 'desc' },
      });
      expect(mockSolLogService.getLogsForPlan).toHaveBeenCalledWith('zone-1', latestJobId);
      expect(result.complete).toBe(true);
    });
  });

  describe('rebootDirectProvisionDevice', () => {
    const rebootAggregate = () =>
      ({
        ...mockDeployment,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
        isLocked: false,
      }) as any;

    it('reboots via the lifecycle engine', async () => {
      const agg = rebootAggregate();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(agg);
      mockLifecycleService.requestReboot.mockResolvedValue({ data: { id: 'job-1' } });

      const result = await service.rebootDirectProvisionDevice(mockDeployment.id);

      expect(mockLifecycleService.requestReboot).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: agg.server.device.id, deploymentId: mockDeployment.id }),
      );
      expect(mockContextService.requirePermission).toHaveBeenCalledWith('device', 'power-control');
      expect(result).toEqual({ data: { id: 'job-1' } });
    });

    it('throws NotFoundException when deployment not found', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(null);
      await expect(service.rebootDirectProvisionDevice(mockDeployment.id)).rejects.toThrow(NotFoundException);
    });

    it('throws BadRequestException when locked', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({
        ...rebootAggregate(),
        isLocked: true,
      } as any);
      await expect(service.rebootDirectProvisionDevice(mockDeployment.id)).rejects.toThrow(BadRequestException);
    });
  });

  describe('powerControlDevice', () => {
    it('should control device power', async () => {
      const mockAggregate = {
        ...mockDeployment,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
        isLocked: false,
      } as any;

      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(mockAggregate);
      mockLifecycleService.requestPowerControl.mockResolvedValue({ data: { id: 'job-1' } });

      const result = await service.powerControlDevice(mockDeployment.id, { operation: 'off' });
      expect(mockContextService.requirePermission).toHaveBeenCalledWith('device', 'power-control');

      expect(mockLifecycleService.requestPowerControl).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'off',
          deviceId: mockAggregate.server.device.id,
          deploymentId: mockDeployment.id,
        }),
      );
      expect(result).toEqual({ data: { id: 'job-1' } });
    });

    it('should throw NotFoundException when deployment not found', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(null);
      await expect(service.powerControlDevice(mockDeployment.id, { operation: 'off' })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw BadRequestException when locked', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockDeployment,
        isLocked: true,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
      } as any);
      await expect(service.powerControlDevice(mockDeployment.id, { operation: 'off' })).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('deprovisionDirectProvisionDevice', () => {
    it('should deprovision device', async () => {
      const agg = {
        ...mockDeployment,
        isLocked: false,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
      } as any;
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(agg);
      mockLifecycleService.requestDeprovision.mockResolvedValue({ data: { id: 'job-1' } });

      const result = await service.deprovisionDirectProvisionDevice(mockDeployment.id);
      expect(mockLifecycleService.requestDeprovision).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: agg.server.device.id }),
      );
      expect(result).toEqual({ data: { id: 'job-1' } });
    });

    it('should throw NotFoundException when not found', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(null);
      await expect(service.deprovisionDirectProvisionDevice(mockDeployment.id)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when locked', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockDeployment,
        isLocked: true,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
      } as any);
      await expect(service.deprovisionDirectProvisionDevice(mockDeployment.id)).rejects.toThrow(BadRequestException);
    });
  });

  describe('updateDeploymentNickname', () => {
    it('should rename via DeploymentRecord and return presenter response', async () => {
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(record as any);
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({ id: 'dep-1' } as any);
      vi.spyOn(DeploymentPresenter, 'toResponse').mockReturnValue({ id: 'formatted' } as any);

      const result = await service.updateDeploymentNickname(mockDeployment.id, { name: 'New Name' });

      expect(record.rename).toHaveBeenCalledWith('New Name');
      expect(record.save).toHaveBeenCalled();
      expect(result).toEqual({ id: 'formatted' });
    });

    it('should throw NotFoundException when not found', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(null);
      await expect(service.updateDeploymentNickname(mockDeployment.id, { name: 'New' })).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('reprovisionDirectProvisionDeployment', () => {
    it('reads the device unscoped so a customer outside the supplier organization can reprovision', async () => {
      const mockAggregate = {
        ...mockDeployment,
        isLocked: false,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
      } as any;

      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(mockAggregate);
      const scoped = vi.spyOn(BaremetalRecord, 'findByDeviceId');
      const unscoped = vi.spyOn(BaremetalRecord, 'findByIdUnscoped').mockResolvedValue({
        data: { deletedAt: null },
      } as unknown as BaremetalRecord);
      mockLifecycleService.requestReprovision.mockResolvedValue({ id: 'job-1' } as any);

      const result = await service.reprovisionDirectProvisionDeployment(mockDeployment.id, {
        deploymentName: 'Test',
        operatingSystem: 'ubuntu-focal-hpc' as OperatingSystemSlug,
        sshKeyIds: ['key-1'],
        diskLayouts: [],
      });

      expect(mockLifecycleService.requestReprovision).toHaveBeenCalledWith(
        expect.objectContaining({
          deviceId: mockAggregate.server.device.id,
          operatingSystemSlug: 'ubuntu-focal-hpc',
          sshKeyIds: ['key-1'],
          customizations: null,
          tee: false,
        }),
      );
      expect(result).toEqual({ id: 'job-1' });
      expect(unscoped).toHaveBeenCalledWith(mockAggregate.server.device.id, { includeDeleted: true });
      expect(scoped).not.toHaveBeenCalled();
    });

    it('forwards the device storageDrives to the homogeneity check', async () => {
      const storageDrives = [{ id: 'drive-1', name: 'nvme0n1' }];
      const diskLayouts: ReprovisionDiskLayout[] = [
        { config: 'lvm', format: 'ext4', mountpoint: '/', diskType: 'nvme', disks: ['nvme0n1'], wipe: true },
      ];
      const mockAggregate = {
        ...mockDeployment,
        isLocked: false,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
      } as any;

      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(mockAggregate);
      vi.spyOn(BaremetalRecord, 'findByIdUnscoped').mockResolvedValue({
        data: { deletedAt: null, storageDrives },
      } as unknown as BaremetalRecord);
      mockLifecycleService.requestReprovision.mockResolvedValue({ id: 'job-1' } as any);

      await service.reprovisionDirectProvisionDeployment(mockDeployment.id, {
        deploymentName: 'Test',
        operatingSystem: 'ubuntu-focal-hpc' as OperatingSystemSlug,
        sshKeyIds: ['key-1'],
        diskLayouts,
      });

      expect(mockProvisionValidatorService.validateDiskLayouts).toHaveBeenCalledWith(diskLayouts, 'reprovision');
      expect(mockProvisionValidatorService.validateDiskGroupHomogeneity).toHaveBeenCalledWith(
        diskLayouts,
        storageDrives,
      );
      expect(mockProvisionValidatorService.validateDiskGroupSizeLimits).toHaveBeenCalledWith(
        diskLayouts,
        storageDrives,
      );
    });

    it('should throw NotFoundException when not found', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(null);
      await expect(
        service.reprovisionDirectProvisionDeployment('123', {
          deploymentName: 'Test',
          operatingSystem: 'ubuntu-focal-hpc' as OperatingSystemSlug,
          sshKeyIds: ['k'],
          diskLayouts: [],
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('should throw BadRequestException when locked', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockDeployment,
        isLocked: true,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
      } as any);
      await expect(
        service.reprovisionDirectProvisionDeployment('123', {
          deploymentName: 'Test',
          operatingSystem: 'ubuntu-focal-hpc' as OperatingSystemSlug,
          sshKeyIds: ['k'],
          diskLayouts: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a soft-deleted (decommissioned) device and does not reprovision', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockDeployment,
        isLocked: false,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
      } as any);
      vi.spyOn(BaremetalRecord, 'findByIdUnscoped').mockResolvedValue({
        data: { deletedAt: new Date() },
      } as unknown as BaremetalRecord);
      mockLifecycleService.requestReprovision.mockClear();

      await expect(
        service.reprovisionDirectProvisionDeployment(mockDeployment.id, {
          deploymentName: 'Test',
          operatingSystem: 'ubuntu-focal-hpc' as OperatingSystemSlug,
          sshKeyIds: ['k'],
          diskLayouts: [],
        }),
      ).rejects.toThrow(BadRequestException);
      expect(mockLifecycleService.requestReprovision).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the device record is missing and does not reprovision', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockDeployment,
        isLocked: false,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
      } as any);
      vi.spyOn(BaremetalRecord, 'findByIdUnscoped').mockResolvedValue(null);
      mockLifecycleService.requestReprovision.mockClear();

      await expect(
        service.reprovisionDirectProvisionDeployment(mockDeployment.id, {
          deploymentName: 'Test',
          operatingSystem: 'ubuntu-focal-hpc' as OperatingSystemSlug,
          sshKeyIds: ['k'],
          diskLayouts: [],
        }),
      ).rejects.toThrow(NotFoundException);
      expect(mockLifecycleService.requestReprovision).not.toHaveBeenCalled();
    });

    it('validates flattened customizations against the device hardware and forwards them', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockDeployment,
        isLocked: false,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
      } as any);
      vi.spyOn(BaremetalRecord, 'findByIdUnscoped').mockResolvedValue({
        data: {
          deletedAt: null,
          cpus: [{ model: 'EPYC', architecture: 'aarch64', coreCount: 64, threadCount: 128 }],
          gpus: [{ model: 'NVIDIA H100 80GB' }],
          server: { teeEnabled: true, teeCapable: TeeCapability.TRUE },
        },
      } as unknown as BaremetalRecord);
      mockLifecycleService.requestReprovision.mockResolvedValue({ id: 'job-1' } as any);

      await service.reprovisionDirectProvisionDeployment(mockDeployment.id, {
        deploymentName: 'Test',
        operatingSystem: 'ubuntu-noble-vanilla' as OperatingSystemSlug,
        sshKeyIds: ['key-1'],
        diskLayouts: [],
        customizations: { gpuDriver: 'nvidia-driver-580', miscSoftware: ['docker', 'ollama'] },
      } as any);

      expect(mockProvisionValidatorService.validateCustomizations).toHaveBeenCalledWith(
        ['nvidia-driver-580', 'docker', 'ollama'],
        'NVIDIA H100 80GB',
        true,
        'ubuntu-noble-vanilla',
        'arm64',
        null,
      );
      expect(mockLifecycleService.requestReprovision).toHaveBeenCalledWith(
        expect.objectContaining({ customizations: ['nvidia-driver-580', 'docker', 'ollama'], tee: false }),
      );
    });

    it('forwards tee: true when explicitly set', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockDeployment,
        isLocked: false,
        server: { device: { ...mockDevice, ...mockDeviceMetadata, netboxId: mockDeviceMetadata.id } },
      } as any);
      vi.spyOn(BaremetalRecord, 'findByIdUnscoped').mockResolvedValue({
        data: {
          deletedAt: null,
          cpus: [{ model: 'EPYC', architecture: 'x86_64', coreCount: 64, threadCount: 128 }],
          gpus: [{ model: 'NVIDIA H100 80GB' }],
          server: { teeEnabled: true, teeCapable: TeeCapability.TRUE },
        },
      } as unknown as BaremetalRecord);
      mockLifecycleService.requestReprovision.mockResolvedValue({ id: 'job-1' } as any);

      await service.reprovisionDirectProvisionDeployment(mockDeployment.id, {
        deploymentName: 'Test',
        operatingSystem: 'ipxe-custom' as OperatingSystemSlug,
        sshKeyIds: ['key-1'],
        diskLayouts: [],
        tee: true,
      } as any);

      expect(mockLifecycleService.requestReprovision).toHaveBeenCalledWith(expect.objectContaining({ tee: true }));
    });

    it('forwards tee: true on a standard OS when device is TEE-capable', async () => {
      mockLifecycleService.requestReprovision.mockClear();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockDeployment,
        isLocked: false,
        server: { device: { ...mockDevice, ...mockDeviceMetadata, netboxId: mockDeviceMetadata.id } },
      } as any);
      vi.spyOn(BaremetalRecord, 'findByIdUnscoped').mockResolvedValue({
        data: {
          deletedAt: null,
          cpus: [{ model: 'EPYC', architecture: 'x86_64', coreCount: 64, threadCount: 128 }],
          gpus: [{ model: 'NVIDIA H100 80GB' }],
          server: { teeEnabled: true, teeCapable: TeeCapability.TRUE },
        },
      } as unknown as BaremetalRecord);
      mockLifecycleService.requestReprovision.mockResolvedValue({ id: 'job-1' } as any);

      await service.reprovisionDirectProvisionDeployment(mockDeployment.id, {
        deploymentName: 'Test',
        operatingSystem: 'ubuntu-noble-vanilla' as OperatingSystemSlug,
        sshKeyIds: ['key-1'],
        diskLayouts: [],
        tee: true,
      } as any);

      expect(mockLifecycleService.requestReprovision).toHaveBeenCalledWith(expect.objectContaining({ tee: true }));
    });

    it('rejects tee: true when device is not TEE-capable', async () => {
      mockLifecycleService.requestReprovision.mockClear();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue({
        ...mockDeployment,
        isLocked: false,
        server: { device: { ...mockDevice, ...mockDeviceMetadata, netboxId: mockDeviceMetadata.id } },
      } as any);
      vi.spyOn(BaremetalRecord, 'findByIdUnscoped').mockResolvedValue({
        data: {
          deletedAt: null,
          server: { teeEnabled: false, teeCapable: TeeCapability.UNVERIFIED },
        },
      } as unknown as BaremetalRecord);

      await expect(
        service.reprovisionDirectProvisionDeployment(mockDeployment.id, {
          deploymentName: 'Test',
          operatingSystem: 'ipxe-custom' as OperatingSystemSlug,
          sshKeyIds: ['key-1'],
          diskLayouts: [],
          tee: true,
        } as any),
      ).rejects.toThrow('TEE is not supported on this device');

      expect(mockLifecycleService.requestReprovision).not.toHaveBeenCalled();
    });

    it('propagates BadRequestException from resolveZoneBuildId on reprovision', async () => {
      const mockAggregate = {
        ...mockDeployment,
        isLocked: false,
        server: { device: { ...mockDevice, ...mockDeviceMetadata } },
      } as any;
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(mockAggregate);
      vi.spyOn(BaremetalRecord, 'findByIdUnscoped').mockResolvedValue({
        data: { deletedAt: null, zoneId: 'zone-1' },
      } as unknown as BaremetalRecord);
      vi.mocked(resolveZoneBuildId).mockRejectedValueOnce(new BadRequestException('zone deleted'));

      await expect(
        service.reprovisionDirectProvisionDeployment(mockDeployment.id, {
          deploymentName: 'Test',
          operatingSystem: 'ubuntu-focal-hpc' as OperatingSystemSlug,
          sshKeyIds: ['key-1'],
          diskLayouts: [],
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('toggleDeploymentLock', () => {
    it('should toggle lock via DeploymentRecord', async () => {
      const record = createMockRecord({ isLocked: false });
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(record as any);

      const result = await service.toggleDeploymentLock(mockDeployment.id);

      expect(record.toggleLock).toHaveBeenCalled();
      expect(record.save).toHaveBeenCalled();
      expect(result).toBe(true);
    });

    it('should throw NotFoundException when not found', async () => {
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(null);
      await expect(service.toggleDeploymentLock(mockDeployment.id)).rejects.toThrow(NotFoundException);
    });
  });

  describe('activateRescueMode', () => {
    function buildRescueAggregate() {
      return {
        ...mockDeployment,
        isLocked: false,
        rescueLayer: null,
        lifecycleActions: [],
        lifecycleJobs: [],
        server: {
          device: {
            ...mockDevice,
            ...mockDeviceMetadata,
          },
        },
        deploymentKeys: mockDeploymentKeys,
      } as any;
    }

    it('rejects when the deployment is mid-lifecycle (not provisioned/failed) so it cannot clobber brokkr-discovery', async () => {
      const aggregate = buildRescueAggregate();
      aggregate.server.lifecycleStatus = 'PROVISIONING';
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(createMockRecord() as any);

      await expect(service.activateRescueMode(mockDeployment.id)).rejects.toThrow(BadRequestException);

      expect(mockRebootDevice).not.toHaveBeenCalled();
    });

    it('writes the server-token atom before rebooting the device', async () => {
      const aggregate = buildRescueAggregate();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(record as any);
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(mockUbuntuRescueOS as any);

      const callOrder: string[] = [];
      mockServerTokenWrite.mockImplementationOnce(async () => {
        callOrder.push('writeForDeviceBestEffort');
      });
      mockRebootDevice.mockImplementationOnce(async () => {
        callOrder.push('rebootDevice');
      });

      const jobId = await service.activateRescueMode(mockDeployment.id);

      expect(mockServerTokenWrite).toHaveBeenCalledOnce();
      expect(mockServerTokenWrite).toHaveBeenCalledWith(aggregate.server.device.id, {
        requestId: jobId,
        opLabel: 'rescue activate',
      });
      expect(mockDeviceRecordWrite).toHaveBeenCalledWith(aggregate.server.device.id, {
        requestId: jobId,
      });
      expect(mockRebootDevice).toHaveBeenCalledWith(aggregate.server.device.id, jobId, { bootDevice: 'pxe' });
      expect(callOrder).toEqual(['writeForDeviceBestEffort', 'rebootDevice']);

      expect(record.setRescueLayer).toHaveBeenCalledWith(mockUbuntuRescueOS.id);
      expect(record.save).toHaveBeenCalled();
    });

    it('writes the rescue ssh_pub_keys to the zone-prefixed plain Redis key', async () => {
      const aggregate = buildRescueAggregate();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(record as any);
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(mockUbuntuRescueOS as any);

      const expectedSshKeysStr = mockSshKeys.map((key) => key.key).join('\n');
      const expectedDeviceId = aggregate.server.device.id;

      await service.activateRescueMode(mockDeployment.id);

      expect(mockResolveZoneContext).toHaveBeenCalledWith(aggregate.server.device.id);
      expect(mockConfigAtomSetString).toHaveBeenCalledWith(
        'zone-1',
        `device:${expectedDeviceId}:rescue:ssh_pub_keys`,
        expectedSshKeysStr,
        24 * 60 * 60,
      );

      expect(record.setRescueLayer).toHaveBeenCalledWith(mockUbuntuRescueOS.id);
      expect(record.save).toHaveBeenCalled();
    });

    it('aborts before any side effects when the rescue ssh-keys write rejects (fail-fast)', async () => {
      const aggregate = buildRescueAggregate();
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(record as any);
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(mockUbuntuRescueOS as any);
      mockConfigAtomSetString.mockRejectedValueOnce(new Error('redis down'));

      await expect(service.activateRescueMode(mockDeployment.id)).rejects.toThrow('redis down');

      expect(mockRebootDevice).not.toHaveBeenCalled();
      expect(record.setRescueLayer).not.toHaveBeenCalled();
      expect(record.save).not.toHaveBeenCalled();
    });

    it('still reboots the device when the best-effort atom write resolves silently', async () => {
      const aggregate = buildRescueAggregate();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(createMockRecord() as any);
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(mockUbuntuRescueOS as any);
      mockServerTokenWrite.mockResolvedValueOnce(undefined);

      await expect(service.activateRescueMode(mockDeployment.id)).resolves.toEqual(expect.any(String));

      expect(mockRebootDevice).toHaveBeenCalledOnce();
    });

    it('warns and still reboots when the device_record publish is skipped by the staleness race', async () => {
      const aggregate = buildRescueAggregate();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(createMockRecord() as any);
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(mockUbuntuRescueOS as any);
      mockDeviceRecordWrite.mockResolvedValueOnce({ written: false, reason: 'stale' });

      await expect(service.activateRescueMode(mockDeployment.id)).resolves.toEqual(expect.any(String));

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('Skipped device_record publish for rescue activate'),
        undefined,
      );
      expect(mockRebootDevice).toHaveBeenCalledOnce();
    });

    it('logs an expected skip (no warn) when the role is not published, and still reboots', async () => {
      const aggregate = buildRescueAggregate();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(createMockRecord() as any);
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(mockUbuntuRescueOS as any);
      mockDeviceRecordWrite.mockResolvedValueOnce({ written: false, reason: 'role-not-published' });

      await expect(service.activateRescueMode(mockDeployment.id)).resolves.toEqual(expect.any(String));

      expect(mockLoggerWarn).not.toHaveBeenCalled();
      expect(mockLoggerLog).toHaveBeenCalledWith(expect.stringContaining('not in the publish allow-list'), undefined);
      expect(mockRebootDevice).toHaveBeenCalledOnce();
    });
  });

  describe('deactivateRescueMode', () => {
    function buildDeactivateAggregate() {
      return {
        ...mockDeployment,
        isLocked: false,
        rescueLayer: mockUbuntuRescueOS,
        lifecycleActions: [],
        lifecycleJobs: [],
        server: {
          device: {
            ...mockDevice,
            ...mockDeviceMetadata,
          },
        },
        deploymentKeys: mockDeploymentKeys,
      } as any;
    }

    it('exits rescue mode even when the status is not provisioned/failed (would otherwise strand the device)', async () => {
      const aggregate = buildDeactivateAggregate();
      aggregate.server.lifecycleStatus = 'REBOOTING';
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(record as any);

      await expect(service.deactivateRescueMode(mockDeployment.id)).resolves.toEqual(expect.any(String));

      expect(record.setRescueLayer).toHaveBeenCalledWith(null);
      expect(mockRebootDevice).toHaveBeenCalledOnce();
    });

    it('deletes the rescue ssh_pub_keys key under the device zone prefix', async () => {
      const aggregate = buildDeactivateAggregate();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(record as any);

      const jobId = await service.deactivateRescueMode(mockDeployment.id);
      expect(mockRebootDevice).toHaveBeenCalledWith(aggregate.server.device.id, jobId, { bootDevice: 'pxe' });

      expect(mockResolveZoneContext).toHaveBeenCalledWith(aggregate.server.device.id);
      expect(mockConfigAtomDelKey).toHaveBeenCalledWith(
        'zone-1',
        `device:${aggregate.server.device.id}:rescue:ssh_pub_keys`,
      );

      expect(record.setRescueLayer).toHaveBeenCalledWith(null);
      expect(record.save).toHaveBeenCalled();
    });

    it('still reboots the device when the rescue ssh-keys delete rejects (best-effort)', async () => {
      const aggregate = buildDeactivateAggregate();
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(createMockRecord() as any);
      mockConfigAtomDelKey.mockRejectedValueOnce(new Error('redis down'));

      await expect(service.deactivateRescueMode(mockDeployment.id)).resolves.toEqual(expect.any(String));

      expect(mockRebootDevice).toHaveBeenCalledOnce();
    });

    it('exits rescue mode for a non-default rescue layer slug', async () => {
      const aggregate = buildDeactivateAggregate();
      aggregate.rescueLayer = { ...mockUbuntuRescueOS, slug: 'custom-rescue', name: 'Custom Rescue' };
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(record as any);

      await expect(service.deactivateRescueMode(mockDeployment.id)).resolves.toEqual(expect.any(String));
      expect(record.setRescueLayer).toHaveBeenCalledWith(null);
      expect(mockRebootDevice).toHaveBeenCalledOnce();
    });

    it('rejects when the deployment is not in rescue mode', async () => {
      const aggregate = buildDeactivateAggregate();
      aggregate.rescueLayer = null;
      vi.spyOn(DeploymentRecord, 'findActiveAggregateById').mockResolvedValue(aggregate);
      vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(createMockRecord() as any);

      await expect(service.deactivateRescueMode(mockDeployment.id)).rejects.toThrow(BadRequestException);
      expect(mockRebootDevice).not.toHaveBeenCalled();
    });
  });

  describe('getInterruptibleClaims', () => {
    it('returns the real Device.id (server.deviceId), not the Server PK', async () => {
      mockPrismaClient.interruptibleClaim.findMany.mockResolvedValue([
        {
          id: 'claim-1',
          deploymentName: 'box',
          status: InterruptibleClaimStatus.Pending,
          interruptAt: new Date('2026-01-01T00:00:00.000Z'),
          serverId: 'server-pk',
          server: { deviceId: 'device-uuid' },
        },
      ]);

      const result = await service.getInterruptibleClaims(undefined, {});

      expect(mockPrismaClient.interruptibleClaim.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ include: { server: { select: { deviceId: true } } } }),
      );
      expect(result.data[0].deviceId).toBe('device-uuid');
    });
  });
});
