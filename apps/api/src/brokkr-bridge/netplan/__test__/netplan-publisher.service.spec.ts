import { Test, TestingModule } from '@nestjs/testing';
import { NetplanService } from 'src/devices/netplan/netplan.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { Mock, vi } from 'vitest';
import { NetplanPublisherService } from '../netplan-publisher.service';
import { NetplanRedisWriterService } from '../netplan-redis-writer.service';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';
const ZONE_PREFIX = '1-1-1';
const JOB_ID = 'job-abc-123';
const LIVE_YAML = 'network:\n  version: 2\n  ethernets:\n    enp1s0: {}\n';
const DEPLOY_YAML = 'network:\n  version: 2\n  bonds:\n    bond0: {}\n';

function deviceWithZone(networkType: 'FLAT' | 'VPC' | null) {
  return { zone: networkType === null ? null : { networkType } };
}

describe('NetplanPublisherService', () => {
  let service: NetplanPublisherService;
  let mockDeviceFindUnique: Mock;
  let mockRenderForDevice: Mock;
  let mockWriterSet: Mock;
  let mockLogger: { log: Mock; warn: Mock; error: Mock; debug: Mock; verbose: Mock; setContext: Mock };

  beforeEach(async () => {
    mockDeviceFindUnique = vi.fn().mockResolvedValue(deviceWithZone('FLAT'));
    mockRenderForDevice = vi.fn();
    mockWriterSet = vi.fn().mockResolvedValue({ written: true });
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
        NetplanPublisherService,
        {
          provide: PrismaClient,
          useValue: {
            device: { findUnique: mockDeviceFindUnique },
          },
        },
        {
          provide: NetplanService,
          useValue: { renderForDevice: mockRenderForDevice },
        },
        {
          provide: NetplanRedisWriterService,
          useValue: { set: mockWriterSet },
        },
        {
          provide: `LoggerService${NetplanPublisherService.name}`,
          useValue: mockLogger,
        },
      ],
    }).compile();

    service = module.get<NetplanPublisherService>(NetplanPublisherService);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes both :live and :deploy for a VPC device and returns the deploy YAML', async () => {
    mockDeviceFindUnique.mockResolvedValueOnce(deviceWithZone('VPC'));
    mockRenderForDevice.mockResolvedValueOnce(LIVE_YAML).mockResolvedValueOnce(DEPLOY_YAML);

    const result = await service.publishForProvisioning({
      deviceId: DEVICE_UUID,
      zonePrefix: ZONE_PREFIX,
      jobId: JOB_ID,
    });

    expect(result).toEqual({ deployNetplan: DEPLOY_YAML });

    expect(mockRenderForDevice).toHaveBeenCalledTimes(2);
    expect(mockRenderForDevice).toHaveBeenNthCalledWith(1, DEVICE_UUID, 'live');
    expect(mockRenderForDevice).toHaveBeenNthCalledWith(2, DEVICE_UUID, 'deploy');

    expect(mockWriterSet).toHaveBeenCalledTimes(2);
    expect(mockWriterSet).toHaveBeenNthCalledWith(1, ZONE_PREFIX, DEVICE_UUID, 'live', LIVE_YAML);
    expect(mockWriterSet).toHaveBeenNthCalledWith(2, ZONE_PREFIX, DEVICE_UUID, 'deploy', DEPLOY_YAML);
  });

  it('writes only :live for a non-VPC device and returns deployNetplan=null', async () => {
    mockRenderForDevice.mockResolvedValueOnce(LIVE_YAML);

    const result = await service.publishForProvisioning({
      deviceId: DEVICE_UUID,
      zonePrefix: ZONE_PREFIX,
      jobId: JOB_ID,
    });

    expect(result).toEqual({ deployNetplan: null });

    expect(mockRenderForDevice).toHaveBeenCalledTimes(1);
    expect(mockRenderForDevice).toHaveBeenCalledWith(DEVICE_UUID, 'live');

    expect(mockWriterSet).toHaveBeenCalledTimes(1);
    expect(mockWriterSet).toHaveBeenCalledWith(ZONE_PREFIX, DEVICE_UUID, 'live', LIVE_YAML);
    expect(mockWriterSet).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), 'deploy', expect.anything());
  });

  it('propagates render failure on :live and never writes', async () => {
    mockDeviceFindUnique.mockResolvedValueOnce(deviceWithZone('VPC'));
    mockRenderForDevice.mockRejectedValueOnce(new Error('render exploded'));

    await expect(
      service.publishForProvisioning({
        deviceId: DEVICE_UUID,
        zonePrefix: ZONE_PREFIX,
        jobId: JOB_ID,
      }),
    ).rejects.toThrow('render exploded');

    expect(mockWriterSet).not.toHaveBeenCalled();
    expect(mockRenderForDevice).toHaveBeenCalledTimes(1);
  });

  it('propagates render failure on :deploy after :live was written', async () => {
    mockDeviceFindUnique.mockResolvedValueOnce(deviceWithZone('VPC'));
    mockRenderForDevice.mockResolvedValueOnce(LIVE_YAML).mockRejectedValueOnce(new Error('deploy render failed'));

    await expect(
      service.publishForProvisioning({
        deviceId: DEVICE_UUID,
        zonePrefix: ZONE_PREFIX,
        jobId: JOB_ID,
      }),
    ).rejects.toThrow('deploy render failed');

    expect(mockWriterSet).toHaveBeenCalledTimes(1);
    expect(mockWriterSet).toHaveBeenCalledWith(ZONE_PREFIX, DEVICE_UUID, 'live', LIVE_YAML);
  });

  it('treats a device with no zone as non-VPC and writes only :live', async () => {
    mockDeviceFindUnique.mockResolvedValueOnce(deviceWithZone(null));
    mockRenderForDevice.mockResolvedValueOnce(LIVE_YAML);

    const result = await service.publishForProvisioning({
      deviceId: DEVICE_UUID,
      zonePrefix: ZONE_PREFIX,
      jobId: JOB_ID,
    });

    expect(result).toEqual({ deployNetplan: null });
    expect(mockRenderForDevice).toHaveBeenCalledTimes(1);
    expect(mockWriterSet).toHaveBeenCalledTimes(1);
    expect(mockWriterSet).toHaveBeenCalledWith(ZONE_PREFIX, DEVICE_UUID, 'live', LIVE_YAML);
  });

  it('propagates writer.set failure on :live and does not attempt :deploy', async () => {
    mockDeviceFindUnique.mockResolvedValueOnce(deviceWithZone('VPC'));
    mockRenderForDevice.mockResolvedValueOnce(LIVE_YAML);
    mockWriterSet.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      service.publishForProvisioning({
        deviceId: DEVICE_UUID,
        zonePrefix: ZONE_PREFIX,
        jobId: JOB_ID,
      }),
    ).rejects.toThrow('redis down');

    expect(mockRenderForDevice).toHaveBeenCalledTimes(1);
    expect(mockWriterSet).toHaveBeenCalledTimes(1);
  });

  it('warns (but does not throw) when the :live netplan write is stale', async () => {
    mockRenderForDevice.mockResolvedValueOnce(LIVE_YAML);
    mockWriterSet.mockResolvedValueOnce({ written: false, reason: 'stale' });

    const result = await service.publishForProvisioning({
      deviceId: DEVICE_UUID,
      zonePrefix: ZONE_PREFIX,
      jobId: JOB_ID,
    });

    expect(result).toEqual({ deployNetplan: null });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('live netplan write skipped (stale)'), JOB_ID);
  });

  it('warns (but does not throw) when the VPC :deploy netplan write is stale', async () => {
    mockDeviceFindUnique.mockResolvedValueOnce(deviceWithZone('VPC'));
    mockRenderForDevice.mockResolvedValueOnce(LIVE_YAML).mockResolvedValueOnce(DEPLOY_YAML);
    mockWriterSet.mockResolvedValueOnce({ written: true }).mockResolvedValueOnce({ written: false, reason: 'stale' });

    const result = await service.publishForProvisioning({
      deviceId: DEVICE_UUID,
      zonePrefix: ZONE_PREFIX,
      jobId: JOB_ID,
    });

    expect(result).toEqual({ deployNetplan: DEPLOY_YAML });
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('deploy netplan write skipped (stale)'),
      JOB_ID,
    );
  });

  describe('renderLiveNetplan', () => {
    it('renders the live YAML for the Device UUID without a writer call', async () => {
      mockRenderForDevice.mockResolvedValueOnce(LIVE_YAML);

      const result = await service.renderLiveNetplan({ deviceId: DEVICE_UUID, jobId: JOB_ID });

      expect(result).toBe(LIVE_YAML);
      expect(mockRenderForDevice).toHaveBeenCalledTimes(1);
      expect(mockRenderForDevice).toHaveBeenCalledWith(DEVICE_UUID, 'live');
      expect(mockWriterSet).not.toHaveBeenCalled();
    });
  });

  describe('renderDeployNetplan', () => {
    it('renders the deploy YAML for the Device UUID without a writer call', async () => {
      mockRenderForDevice.mockResolvedValueOnce(DEPLOY_YAML);

      const result = await service.renderDeployNetplan({ deviceId: DEVICE_UUID, jobId: JOB_ID });

      expect(result).toBe(DEPLOY_YAML);
      expect(mockRenderForDevice).toHaveBeenCalledWith(DEVICE_UUID, 'deploy');
      expect(mockWriterSet).not.toHaveBeenCalled();
    });
  });
});
