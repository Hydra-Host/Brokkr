import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { LayerRecord } from '@repo/layers';
import { PrismaClient } from 'src/prisma/prisma.client';
import { Mock, vi } from 'vitest';
import { DeviceRecordPublisher } from '../../device-record/device-record-publisher.service';
import { NetplanRedisWriterService } from '../../netplan/netplan-redis-writer.service';
import { LifecyclePreparationService } from '../lifecycle-preparation.service';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';
const JOB_ID = 'job-abc-123';
const ZONE_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeDevice(overrides: { zoneId?: string | null; status?: string } = {}) {
  return {
    id: DEVICE_UUID,
    zoneId: 'zoneId' in overrides ? overrides.zoneId : ZONE_UUID,
    status: overrides.status ?? 'INVENTORY',
  };
}

describe('LifecyclePreparationService', () => {
  let service: LifecyclePreparationService;
  let mockDeviceFindFirst: Mock;
  let mockDeviceUpdate: Mock;
  let mockDeleteDeploy: Mock;
  let mockLogger: { log: Mock; warn: Mock; error: Mock; debug: Mock; verbose: Mock; setContext: Mock };

  let mockDeviceFindUnique: Mock;
  let mockWriteRecordForDevice: Mock;
  let mockDeploymentFindFirst: Mock;
  let mockDeploymentUpdate: Mock;

  beforeEach(async () => {
    vi.stubEnv('LOCAL_SIMULATION_ENABLED', '');
    mockDeviceFindFirst = vi.fn().mockResolvedValue(makeDevice());
    mockDeviceFindUnique = vi.fn().mockResolvedValue(makeDevice());
    mockDeviceUpdate = vi.fn().mockResolvedValue({});
    mockDeleteDeploy = vi.fn().mockResolvedValue(undefined);
    mockWriteRecordForDevice = vi.fn().mockResolvedValue({ written: true });
    mockDeploymentFindFirst = vi.fn().mockResolvedValue(null);
    mockDeploymentUpdate = vi.fn().mockResolvedValue({});
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
        LifecyclePreparationService,
        {
          provide: PrismaClient,
          useValue: {
            device: {
              findFirst: mockDeviceFindFirst,
              findUnique: mockDeviceFindUnique,
              update: mockDeviceUpdate,
            },
            deployment: { findFirst: mockDeploymentFindFirst, update: mockDeploymentUpdate },
          },
        },
        {
          provide: NetplanRedisWriterService,
          useValue: { deleteDeploy: mockDeleteDeploy },
        },
        {
          provide: DeviceRecordPublisher,
          useValue: { writeForDevice: mockWriteRecordForDevice },
        },
        {
          provide: `LoggerService${LifecyclePreparationService.name}`,
          useValue: mockLogger,
        },
      ],
    }).compile();

    service = module.get<LifecyclePreparationService>(LifecyclePreparationService);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe('prepareForDeprovision', () => {
    it('calls deleteDeploy with the correct zone prefix after the Prisma update', async () => {
      const callOrder: string[] = [];
      mockDeviceUpdate.mockImplementation(async () => {
        callOrder.push('prismaUpdate');
        return {};
      });
      mockDeleteDeploy.mockImplementation(async () => {
        callOrder.push('deleteDeploy');
      });

      await service.prepareForDeprovision(DEVICE_UUID, JOB_ID);

      expect(mockDeleteDeploy).toHaveBeenCalledOnce();
      expect(mockDeleteDeploy).toHaveBeenCalledWith(ZONE_UUID, DEVICE_UUID);
      expect(callOrder).toEqual(['prismaUpdate', 'deleteDeploy']);
    });

    it('throws NotFoundException when device is not found', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(null);

      await expect(service.prepareForDeprovision(DEVICE_UUID, JOB_ID)).rejects.toThrow(NotFoundException);

      expect(mockDeleteDeploy).not.toHaveBeenCalled();
    });

    it('updates Prisma with deprovisioning lifecycle status keyed by Device UUID', async () => {
      await service.prepareForDeprovision(DEVICE_UUID, JOB_ID);

      expect(mockDeviceUpdate).toHaveBeenCalledWith({
        where: { id: DEVICE_UUID },
        data: {
          lastJobId: JOB_ID,
          server: {
            upsert: {
              create: { lifecycleStatus: 'DEPROVISIONING' },
              update: { lifecycleStatus: 'DEPROVISIONING' },
            },
          },
        },
      });
    });

    it('logs a warning and skips deleteDeploy when device has no zoneId (null device)', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice({ zoneId: null }));

      await service.prepareForDeprovision(DEVICE_UUID, JOB_ID);

      expect(mockDeleteDeploy).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('skipping :deploy netplan deletion'),
        JOB_ID,
      );
    });

    it('propagates deleteDeploy failure to the caller', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice());
      mockDeviceUpdate.mockResolvedValueOnce({});
      mockDeleteDeploy.mockRejectedValueOnce(new Error('redis down'));

      await expect(service.prepareForDeprovision(DEVICE_UUID, JOB_ID)).rejects.toThrow('redis down');

      expect(mockDeviceUpdate).toHaveBeenCalledTimes(1);
      expect(mockDeleteDeploy).toHaveBeenCalledTimes(1);
    });
  });

  describe('prepareForProvision', () => {
    it('does not call deleteDeploy', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice());

      await service.prepareForProvision(DEVICE_UUID, JOB_ID);

      expect(mockDeleteDeploy).not.toHaveBeenCalled();
    });

    it('publishes the device_record atom after the status flip', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice());

      await service.prepareForProvision(DEVICE_UUID, JOB_ID);

      expect(mockWriteRecordForDevice).toHaveBeenCalledWith(DEVICE_UUID, { requestId: JOB_ID });
    });

    it('swallows publisher errors so a Redis blip does not block provisioning', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice());
      mockWriteRecordForDevice.mockRejectedValueOnce(new Error('redis down'));

      await expect(service.prepareForProvision(DEVICE_UUID, JOB_ID)).resolves.not.toThrow();
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('warns (and does not throw) when the device_record publish is skipped by the staleness race', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice());
      mockWriteRecordForDevice.mockResolvedValueOnce({ written: false, reason: 'stale' });

      await expect(service.prepareForProvision(DEVICE_UUID, JOB_ID)).resolves.not.toThrow();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipped device_record publish for prepareForProvision'),
        JOB_ID,
      );
    });

    it('logs an expected skip (no warn) when the role is not published', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice());
      mockWriteRecordForDevice.mockResolvedValueOnce({ written: false, reason: 'role-not-published' });

      await expect(service.prepareForProvision(DEVICE_UUID, JOB_ID)).resolves.not.toThrow();
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('not in the publish allow-list'), JOB_ID);
    });
  });

  describe('prepareForDeprovision device_record hook', () => {
    it('publishes the device_record atom after the status flip', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice());

      await service.prepareForDeprovision(DEVICE_UUID, JOB_ID);

      expect(mockWriteRecordForDevice).toHaveBeenCalledWith(DEVICE_UUID, { requestId: JOB_ID });
    });

    it('swallows publisher errors so a Redis blip does not block deprovision', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice());
      mockWriteRecordForDevice.mockRejectedValueOnce(new Error('redis down'));

      await expect(service.prepareForDeprovision(DEVICE_UUID, JOB_ID)).resolves.not.toThrow();
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('warns (and does not throw) when the device_record publish is skipped by the staleness race', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice());
      mockWriteRecordForDevice.mockResolvedValueOnce({ written: false, reason: 'stale' });

      await expect(service.prepareForDeprovision(DEVICE_UUID, JOB_ID)).resolves.not.toThrow();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipped device_record publish for prepareForDeprovision'),
        JOB_ID,
      );
    });

    it('logs an expected skip (no warn) when the role is not published', async () => {
      mockDeviceFindUnique.mockResolvedValueOnce(makeDevice());
      mockWriteRecordForDevice.mockResolvedValueOnce({ written: false, reason: 'role-not-published' });

      await expect(service.prepareForDeprovision(DEVICE_UUID, JOB_ID)).resolves.not.toThrow();
      expect(mockLogger.warn).not.toHaveBeenCalled();
      expect(mockLogger.log).toHaveBeenCalledWith(expect.stringContaining('not in the publish allow-list'), JOB_ID);
    });
  });

  describe('setDeploymentRescueOs', () => {
    it('no-ops when there is no active deployment', async () => {
      mockDeploymentFindFirst.mockResolvedValueOnce(null);

      await service.setDeploymentRescueOs(DEVICE_UUID, 'brokkr-discovery', JOB_ID);

      expect(mockDeploymentUpdate).not.toHaveBeenCalled();
    });

    it('warns and returns without updating when the layer slug is not found', async () => {
      mockDeploymentFindFirst.mockResolvedValueOnce({ id: 'deploy-1' });
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValueOnce(null);

      await service.setDeploymentRescueOs(DEVICE_UUID, 'nonexistent-os', JOB_ID);

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('not found'), JOB_ID);
      expect(mockDeploymentUpdate).not.toHaveBeenCalled();
    });

    it('writes rescueLayerId when the layer slug resolves', async () => {
      mockDeploymentFindFirst.mockResolvedValueOnce({ id: 'deploy-1' });
      vi.spyOn(LayerRecord, 'findBySlug').mockResolvedValueOnce({ id: 'layer-uuid-123' } as any);

      await service.setDeploymentRescueOs(DEVICE_UUID, 'brokkr-discovery', JOB_ID);

      expect(mockDeploymentUpdate).toHaveBeenCalledWith({
        where: { id: 'deploy-1' },
        data: { rescueLayerId: 'layer-uuid-123' },
      });
    });

    it('clears rescueLayerId when osSlug is null', async () => {
      mockDeploymentFindFirst.mockResolvedValueOnce({ id: 'deploy-1' });

      await service.setDeploymentRescueOs(DEVICE_UUID, null, JOB_ID);

      expect(mockDeploymentUpdate).toHaveBeenCalledWith({
        where: { id: 'deploy-1' },
        data: { rescueLayerId: null },
      });
    });
  });
});
