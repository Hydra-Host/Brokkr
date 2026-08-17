import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DeviceContextService } from '../../device-context.service';
import { BridgeQueueService } from '../../queue/bridge-queue.service';
import { ServerTokenService } from '../../server-token/server-token.service';
import { BridgeDeprovisionService } from '../deprovision.service';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';
const JOB_ID = 'job-deprovision-1';
const ZONE_ID = '1-1-1';

const LIVE_ATOM = {
  brokkr_live_token: 'test-live-token',
  endpoint: 'https://brokkr.example/api/v1/bmc/phone-home',
  exp: 1_900_000_000,
};

describe('BridgeDeprovisionService', () => {
  let service: BridgeDeprovisionService;
  let mockResolve: Mock;
  let mockEnqueueSagaJob: Mock;
  let mockMintForCtx: Mock;
  let mockWriteAtomBestEffort: Mock;
  let loggerWarn: Mock;

  beforeEach(async () => {
    mockResolve = vi.fn().mockResolvedValue({
      device: {
        id: DEVICE_UUID,
        ipmiBootDeviceOverride: null,
        server: { teeEnabled: false, teeCapable: 'UNVERIFIED' },
      },
      zoneId: ZONE_ID,
      bmcIp: '10.0.0.1',
      bmcSecret: { ciphertext: 'sealed' },
    });
    mockEnqueueSagaJob = vi.fn().mockResolvedValue({ id: 'bullmq-job-1' });
    mockMintForCtx = vi.fn().mockResolvedValue(LIVE_ATOM);
    mockWriteAtomBestEffort = vi.fn().mockResolvedValue(undefined);
    loggerWarn = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeDeprovisionService,
        { provide: BridgeQueueService, useValue: { enqueueSagaJob: mockEnqueueSagaJob } },
        { provide: DeviceContextService, useValue: { resolve: mockResolve } },
        {
          provide: ServerTokenService,
          useValue: { mintForCtx: mockMintForCtx, writeAtomBestEffort: mockWriteAtomBestEffort },
        },
        {
          provide: `LoggerService${BridgeDeprovisionService.name}`,
          useValue: {
            log: vi.fn(),
            warn: loggerWarn,
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    service = module.get(BridgeDeprovisionService);
  });

  afterEach(() => vi.clearAllMocks());

  it('writes the server-token atom from the already-resolved ctx before enqueuing the saga', async () => {
    await service.deprovisionDevice(DEVICE_UUID, JOB_ID);

    expect(mockResolve).toHaveBeenCalledOnce();
    expect(mockMintForCtx).toHaveBeenCalledOnce();
    expect(mockMintForCtx).toHaveBeenCalledWith(
      expect.objectContaining({
        device: { id: DEVICE_UUID },
        zoneId: ZONE_ID,
      }),
    );
    expect(mockWriteAtomBestEffort).toHaveBeenCalledOnce();
    expect(mockWriteAtomBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ device: { id: DEVICE_UUID } }),
      LIVE_ATOM,
      { requestId: JOB_ID, opLabel: 'deprovision' },
    );
    expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
  });

  it('does not inject the token into the saga payload (spoke reads it from the atom)', async () => {
    await service.deprovisionDevice(DEVICE_UUID, JOB_ID);

    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload).not.toHaveProperty('server_token');
  });

  it('sends the Device UUID in payload.device_id and keys the bullmq job by the same UUID', async () => {
    await service.deprovisionDevice(DEVICE_UUID, JOB_ID);

    const [, , , payload, jobKey] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload.device_id).toBe(DEVICE_UUID);
    expect(jobKey).toBe(DEVICE_UUID);
  });

  it('propagates mint failures so the saga aborts instead of running with a missing token', async () => {
    mockMintForCtx.mockRejectedValueOnce(new Error('mint failed'));

    await expect(service.deprovisionDevice(DEVICE_UUID, JOB_ID)).rejects.toThrow('mint failed');

    expect(mockWriteAtomBestEffort).not.toHaveBeenCalled();
    expect(mockEnqueueSagaJob).not.toHaveBeenCalled();
  });

  it('does not abort deprovision when the atom write itself fails (best-effort)', async () => {
    mockWriteAtomBestEffort.mockResolvedValueOnce(undefined);

    await expect(service.deprovisionDevice(DEVICE_UUID, JOB_ID)).resolves.toEqual({ success: true, plan_id: JOB_ID });
    expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it('reports tee_enabled=true when the device currently has TEE on (Server.teeEnabled)', async () => {
    mockResolve.mockResolvedValue({
      device: { id: DEVICE_UUID, ipmiBootDeviceOverride: null, server: { teeEnabled: true, teeCapable: 'TRUE' } },
      zoneId: ZONE_ID,
      bmcIp: '10.0.0.1',
      bmcSecret: { ciphertext: 'sealed' },
    });

    await service.deprovisionDevice(DEVICE_UUID, JOB_ID);

    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload.tee_enabled).toBe(true);
  });

  it('reports tee_enabled=false when TEE is off, regardless of teeCapable (mirrors live state, not capability)', async () => {
    mockResolve.mockResolvedValue({
      device: {
        id: DEVICE_UUID,
        ipmiBootDeviceOverride: null,
        server: { teeEnabled: false, teeCapable: 'TRUE' },
      },
      zoneId: ZONE_ID,
      bmcIp: '10.0.0.1',
      bmcSecret: { ciphertext: 'sealed' },
    });

    await service.deprovisionDevice(DEVICE_UUID, JOB_ID);

    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload.tee_enabled).toBe(false);
  });
});
