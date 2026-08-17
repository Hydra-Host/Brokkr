import { HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import type { Job } from 'bullmq';
import { type SealedSecretEnvelope } from 'src/device-secret/device-secret.service';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DeviceContextService } from '../../device-context.service';
import { BridgeQueueService, type LifecycleJobData } from '../../queue/bridge-queue.service';
import { BridgePowerControlService } from '../power-control.service';

const ZONE_ID = '550e8400-e29b-41d4-a716-446655440000';
const JOB_ID = 'job-power-status-1';
const BMC_IP = '10.0.0.7';

const SEALED_BMC: SealedSecretEnvelope = {
  zoneId: ZONE_ID,
  zoneKeyId: 'zone-enrollment-1',
  deviceId: JOB_ID,
  purpose: DeviceSecretPurpose.BMC,
  kind: DeviceSecretKind.USER,
  keyGen: 1,
  ephPub: 'ZXBoZW1lcmFsLXB1Yg==',
  ciphertext: 'c2VhbGVkLWJtYy1ibG9i',
  tag: 'dGFn',
};

describe('BridgePowerControlService', () => {
  let service: BridgePowerControlService;
  let mockEnqueueSagaJob: Mock;
  let mockGetState: Mock;
  let mockGetJob: Mock;
  let mockRemove: Mock;
  let bullmqJob: { id: string; getState: Mock; remove: Mock };

  beforeEach(async () => {
    mockGetState = vi.fn().mockResolvedValue('active');
    mockRemove = vi.fn().mockResolvedValue(undefined);
    bullmqJob = { id: 'bullmq-job-1', getState: mockGetState, remove: mockRemove };
    mockEnqueueSagaJob = vi.fn().mockResolvedValue(bullmqJob);
    mockGetJob = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgePowerControlService,
        {
          provide: BridgeQueueService,
          useValue: {
            enqueueSagaJob: mockEnqueueSagaJob,
            getLifecycleQueue: vi.fn().mockReturnValue({ getJob: mockGetJob }),
          },
        },
        { provide: DeviceContextService, useValue: { resolve: vi.fn() } },
        {
          provide: `LoggerService${BridgePowerControlService.name}`,
          useValue: {
            log: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    service = module.get(BridgePowerControlService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe('checkPowerStatus', () => {
    const startAtPickupBoundary = (finalState: string, stateAfterRemove = finalState) => {
      vi.useFakeTimers();
      const deadline = Date.now() + 120_000;
      mockGetState.mockImplementation(async () => {
        if (Date.now() < deadline) return 'waiting';
        return mockRemove.mock.calls.length === 0 ? finalState : stateAfterRemove;
      });

      return service.checkPowerStatus(ZONE_ID, BMC_IP, SEALED_BMC, JOB_ID);
    };

    it('dispatches the power_status saga keyed by jobId', async () => {
      await service.checkPowerStatus(ZONE_ID, BMC_IP, SEALED_BMC, JOB_ID);

      expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
      const [zoneId, sagaName, planId, , bullmqDeviceKey] = mockEnqueueSagaJob.mock.calls[0];
      expect(zoneId).toBe(ZONE_ID);
      expect(sagaName).toBe('power_status');
      expect(planId).toBe(JOB_ID);
      expect(bullmqDeviceKey).toBe(JOB_ID);
    });

    it('builds the payload the bridge consumes: jobId device_id, bmc_ip, sealed bmc', async () => {
      await service.checkPowerStatus(ZONE_ID, BMC_IP, SEALED_BMC, JOB_ID);

      const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
      expect(payload).toEqual({
        device_id: JOB_ID,
        bmc_ip: BMC_IP,
        secrets: { bmc: SEALED_BMC },
      });
      expect(payload.secrets.bmc).toBe(SEALED_BMC);
    });

    it('returns the picked-up bullmq job', async () => {
      const job = await service.checkPowerStatus(ZONE_ID, BMC_IP, SEALED_BMC, JOB_ID);
      expect(job.id).toBe('bullmq-job-1');
    });

    it('accepts a job that becomes active at the pickup timeout boundary', async () => {
      const assertion = expect(startAtPickupBoundary('active')).resolves.toBe(bullmqJob);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('accepts a job that completes at the pickup timeout boundary', async () => {
      const assertion = expect(startAtPickupBoundary('completed')).resolves.toBe(bullmqJob);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('accepts a delayed job that a bridge processed before the pickup timeout boundary', async () => {
      const freshJob = { processedOn: Date.now(), attemptsMade: 1 };
      mockGetJob.mockResolvedValue(freshJob);

      const assertion = expect(startAtPickupBoundary('delayed')).resolves.toBe(freshJob);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('removes a delayed job that was never processed', async () => {
      mockGetJob.mockResolvedValue({ processedOn: null });

      const assertion = expect(startAtPickupBoundary('delayed')).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(mockRemove).toHaveBeenCalledOnce();
    });

    it('removes an unstarted job before returning service unavailable', async () => {
      const assertion = expect(startAtPickupBoundary('waiting')).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(mockRemove).toHaveBeenCalledOnce();
    });

    it('returns the job when removal loses a pickup race', async () => {
      mockRemove.mockRejectedValue(new Error('job is locked'));

      const assertion = expect(startAtPickupBoundary('waiting', 'active')).resolves.toBe(bullmqJob);
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(mockRemove).toHaveBeenCalledOnce();
    });

    it('returns service unavailable when removal fails before pickup', async () => {
      mockRemove.mockRejectedValue(new Error('redis unavailable'));

      const assertion = expect(startAtPickupBoundary('waiting')).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });
      await vi.advanceTimersByTimeAsync(120_000);
      await assertion;
      expect(mockRemove).toHaveBeenCalledOnce();
    });
  });

  describe('waitForJobCompletion', () => {
    const jobWithState = (state: string) =>
      ({ id: 'bullmq-job-1', getState: vi.fn().mockResolvedValue(state) }) as unknown as Job<LifecycleJobData>;

    it('reports failed when the saga plan failed even though bullmq marks the job completed', async () => {
      mockGetJob.mockResolvedValue({ returnvalue: { plan_id: JOB_ID, status: 'failed' } });

      const outcome = await service.waitForJobCompletion(jobWithState('completed'), ZONE_ID);

      expect(outcome).toBe('failed');
    });

    it('reports completed when both the bullmq job and the plan completed', async () => {
      mockGetJob.mockResolvedValue({ returnvalue: { plan_id: JOB_ID, status: 'complete' } });

      const outcome = await service.waitForJobCompletion(jobWithState('completed'), ZONE_ID);

      expect(outcome).toBe('completed');
    });

    it('reports failed when the bullmq job itself failed (worker threw)', async () => {
      const outcome = await service.waitForJobCompletion(jobWithState('failed'), ZONE_ID);

      expect(outcome).toBe('failed');
      expect(mockGetJob).not.toHaveBeenCalled();
    });

    it('reports failed when a completed job has no readable plan status', async () => {
      mockGetJob.mockResolvedValue({ returnvalue: null });

      const outcome = await service.waitForJobCompletion(jobWithState('completed'), ZONE_ID);

      expect(outcome).toBe('failed');
    });
  });
});
