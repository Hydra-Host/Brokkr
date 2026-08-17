import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LayerRecord } from '@repo/layers';
import { BenchmarkService } from 'src/brokkr-bridge/benchmarks/benchmarks.service';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { DeviceRecordPublisher } from 'src/brokkr-bridge/device-record/device-record-publisher.service';
import { BridgeInventoryCollectionService } from 'src/brokkr-bridge/lifecycle/inventory-collection.service';
import { BridgePowerControlService } from 'src/brokkr-bridge/lifecycle/power-control.service';
import { ServerTokenService } from 'src/brokkr-bridge/server-token/server-token.service';
import { createLoggerMock, createLoggerProvidersForTest } from 'src/common/logger-test-utils';
import { ConfigAtomWriter } from 'src/common/redis/config-atom-writer.service';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { RescueModeService } from 'src/deployments/rescue-mode.service';
import {
  mockDeployment,
  mockDevice,
  mockDeviceMetadata,
  mockSshKeys,
  mockSupplyOrganizationMembership,
  mockUbuntuRescueOS,
  mockUser,
} from 'src/prisma/fixtures';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { OperatorDeviceOpsService } from '../operator-device-ops.service';

function createMockRecord() {
  return {
    data: { id: mockDeployment.id, isLocked: false },
    save: vi.fn().mockResolvedValue(undefined),
    setRescueLayer: vi.fn().mockReturnThis(),
  };
}

describe('OperatorDeviceOpsService', () => {
  let service: OperatorDeviceOpsService;
  let mockRebootDevice: Mock;
  let mockServerTokenWrite: Mock;
  let mockDeviceRecordWrite: Mock;
  let mockResolveZoneContext: Mock;
  let mockConfigAtomSetString: Mock;
  let mockConfigAtomDelKey: Mock;
  let mockStartInventoryCollection: Mock;
  let mockRunBenchmarks: Mock;
  let mockLoggerWarn: Mock;

  const deviceId = mockDevice.id;

  function buildAggregate(overrides: Record<string, unknown> = {}) {
    return {
      ...mockDeployment,
      isLocked: false,
      rescueLayer: null,
      lifecycleActions: [],
      lifecycleJobs: [],
      server: {
        lifecycleStatus: 'PROVISIONED',
        updatedAt: new Date(),
        device: {
          ...mockDevice,
          ...mockDeviceMetadata,
          status: 'PROVISIONED',
        },
      },
      deploymentKeys: mockSshKeys.map((key) => ({
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
      })),
      ...overrides,
    } as any;
  }

  beforeEach(async () => {
    mockRebootDevice = vi.fn().mockResolvedValue(undefined);
    mockServerTokenWrite = vi.fn().mockResolvedValue({ cipher: 'c', signature: 's' });
    mockDeviceRecordWrite = vi.fn().mockResolvedValue({ written: true });
    mockResolveZoneContext = vi.fn().mockResolvedValue({ zoneId: 'zone-1' });
    mockConfigAtomSetString = vi.fn().mockResolvedValue(undefined);
    mockConfigAtomDelKey = vi.fn().mockResolvedValue(undefined);
    mockStartInventoryCollection = vi.fn().mockResolvedValue({ jobId: 'discovery-1' });
    mockRunBenchmarks = vi
      .fn()
      .mockResolvedValue({ enqueued: true, plan_id: 'p', gpu_burn_run_id: 'g', nccl_run_id: 'n' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OperatorDeviceOpsService,
        RescueModeService,
        {
          provide: BridgeInventoryCollectionService,
          useValue: { startInventoryCollection: mockStartInventoryCollection },
        },
        { provide: BenchmarkService, useValue: { runBenchmarks: mockRunBenchmarks } },
        { provide: DeviceContextService, useValue: { resolveZoneContext: mockResolveZoneContext } },
        { provide: BridgePowerControlService, useValue: { rebootDevice: mockRebootDevice } },
        { provide: ServerTokenService, useValue: { writeForDeviceBestEffort: mockServerTokenWrite } },
        { provide: DeviceRecordPublisher, useValue: { writeForDevice: mockDeviceRecordWrite } },
        {
          provide: ConfigAtomWriter,
          useValue: { setString: mockConfigAtomSetString, delKey: mockConfigAtomDelKey },
        },
        { provide: 'LoggerServiceRescueModeService', useValue: createLoggerMock() },
        ...createLoggerProvidersForTest(),
      ],
    }).compile();

    service = module.get(OperatorDeviceOpsService);
    mockLoggerWarn = module.get<{ warn: Mock }>('LoggerServiceRescueModeService').warn;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('forceDiscovery', () => {
    it('resolves the zone and starts inventory collection', async () => {
      await expect(service.forceDiscovery(deviceId)).resolves.toEqual({ jobId: 'discovery-1' });
      expect(mockResolveZoneContext).toHaveBeenCalledWith(deviceId);
      expect(mockStartInventoryCollection).toHaveBeenCalledWith(deviceId, 'zone-1', 'manual');
    });
  });

  describe('runBenchmarks', () => {
    it('delegates to BenchmarkService', async () => {
      await service.runBenchmarks(deviceId);
      expect(mockRunBenchmarks).toHaveBeenCalledWith(deviceId);
    });
  });

  describe('activateRescueMode', () => {
    it('404s when there is no active deployment', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);
      await expect(service.activateRescueMode(deviceId)).rejects.toThrow(NotFoundException);
      expect(mockRebootDevice).not.toHaveBeenCalled();
    });

    it('rejects locked deployments', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(buildAggregate({ isLocked: true }));
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(createMockRecord() as never);
      await expect(service.activateRescueMode(deviceId)).rejects.toThrow(BadRequestException);
      expect(mockRebootDevice).not.toHaveBeenCalled();
    });

    it('rejects mid-lifecycle deployments', async () => {
      const aggregate = buildAggregate();
      aggregate.server.lifecycleStatus = 'PROVISIONING';
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(aggregate);
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(createMockRecord() as never);
      await expect(service.activateRescueMode(deviceId)).rejects.toThrow(BadRequestException);
      expect(mockRebootDevice).not.toHaveBeenCalled();
    });

    it('404s when the rescue layer slug is unknown', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(buildAggregate());
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(createMockRecord() as never);
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(null);
      await expect(service.activateRescueMode(deviceId, 'missing-rescue')).rejects.toThrow(NotFoundException);
      expect(mockRebootDevice).not.toHaveBeenCalled();
    });

    it('rejects when already in the requested rescue layer', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(
        buildAggregate({ rescueLayer: mockUbuntuRescueOS }),
      );
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(createMockRecord() as never);
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(mockUbuntuRescueOS as never);
      await expect(service.activateRescueMode(deviceId)).rejects.toThrow(BadRequestException);
      expect(mockRebootDevice).not.toHaveBeenCalled();
    });

    it('writes ssh keys, sets the rescue layer, and reboots', async () => {
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(buildAggregate());
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(record as never);
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(mockUbuntuRescueOS as never);

      await service.activateRescueMode(deviceId);

      expect(mockConfigAtomSetString).toHaveBeenCalledWith(
        'zone-1',
        `device:${deviceId}:rescue:ssh_pub_keys`,
        mockSshKeys.map((key) => key.key).join('\n'),
        24 * 60 * 60,
      );
      expect(record.setRescueLayer).toHaveBeenCalledWith(mockUbuntuRescueOS.id);
      expect(record.save).toHaveBeenCalled();
      expect(mockServerTokenWrite).toHaveBeenCalledWith(deviceId, {
        requestId: expect.any(String),
        opLabel: 'admin rescue activate',
      });
      expect(mockRebootDevice).toHaveBeenCalledWith(deviceId, expect.any(String), { bootDevice: 'pxe' });
    });

    it('accepts a custom rescue OS slug', async () => {
      const customLayer = { ...mockUbuntuRescueOS, id: 'custom-id', slug: 'custom-rescue' };
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(buildAggregate());
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(record as never);
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValue(customLayer as never);

      await service.activateRescueMode(deviceId, 'custom-rescue');

      expect(LayerRecord.findBySlug).toHaveBeenCalledWith('custom-rescue');
      expect(record.setRescueLayer).toHaveBeenCalledWith('custom-id');
    });
  });

  describe('deactivateRescueMode', () => {
    it('clears any rescue layer and reboots', async () => {
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(
        buildAggregate({ rescueLayer: mockUbuntuRescueOS }),
      );
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(record as never);

      await service.deactivateRescueMode(deviceId);

      expect(record.setRescueLayer).toHaveBeenCalledWith(null);
      expect(mockConfigAtomDelKey).toHaveBeenCalledWith('zone-1', `device:${deviceId}:rescue:ssh_pub_keys`);
      expect(mockRebootDevice).toHaveBeenCalledWith(deviceId, expect.any(String), { bootDevice: 'pxe' });
    });

    it('exits a custom rescue slug that activate accepted', async () => {
      const customLayer = { ...mockUbuntuRescueOS, id: 'custom-id', slug: 'custom-rescue', name: 'Custom Rescue' };
      const record = createMockRecord();
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(
        buildAggregate({ rescueLayer: customLayer }),
      );
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(record as never);

      await expect(service.deactivateRescueMode(deviceId)).resolves.toBeUndefined();
      expect(record.setRescueLayer).toHaveBeenCalledWith(null);
    });

    it('rejects when not in rescue mode', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(buildAggregate({ rescueLayer: null }));
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(createMockRecord() as never);
      await expect(service.deactivateRescueMode(deviceId)).rejects.toThrow(BadRequestException);
      expect(mockRebootDevice).not.toHaveBeenCalled();
    });

    it('rejects locked deployments', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(
        buildAggregate({ isLocked: true, rescueLayer: mockUbuntuRescueOS }),
      );
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(createMockRecord() as never);
      await expect(service.deactivateRescueMode(deviceId)).rejects.toThrow(BadRequestException);
      expect(mockRebootDevice).not.toHaveBeenCalled();
    });

    it('still reboots when redis key delete fails', async () => {
      vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(
        buildAggregate({ rescueLayer: mockUbuntuRescueOS }),
      );
      vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(createMockRecord() as never);
      mockConfigAtomDelKey.mockRejectedValueOnce(new Error('redis down'));

      await expect(service.deactivateRescueMode(deviceId)).resolves.toBeUndefined();
      expect(mockLoggerWarn).toHaveBeenCalled();
      expect(mockRebootDevice).toHaveBeenCalledOnce();
    });
  });
});
