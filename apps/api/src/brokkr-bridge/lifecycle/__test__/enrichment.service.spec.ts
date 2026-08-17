import { Test, TestingModule } from '@nestjs/testing';
import { DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import { type SealedSecretEnvelope } from 'src/device-secret/device-secret.service';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { BridgeQueueService } from '../../queue/bridge-queue.service';
import { BridgeEnrichmentService } from '../enrichment.service';

const ZONE_ID = '550e8400-e29b-41d4-a716-446655440000';
const PLAN_ID = 'plan-enrich-1';
const BMC_IP = '10.0.0.5';

const SEALED_BMC: SealedSecretEnvelope = {
  zoneId: ZONE_ID,
  zoneKeyId: 'zone-enrollment-1',
  deviceId: PLAN_ID,
  purpose: DeviceSecretPurpose.BMC,
  kind: DeviceSecretKind.USER,
  keyGen: 1,
  ephPub: 'ZXBoZW1lcmFsLXB1Yg==',
  ciphertext: 'c2VhbGVkLWJtYy1ibG9i',
  tag: 'dGFn',
};

describe('BridgeEnrichmentService', () => {
  let service: BridgeEnrichmentService;
  let mockEnqueueSagaJob: Mock;

  beforeEach(async () => {
    mockEnqueueSagaJob = vi.fn().mockResolvedValue({ id: 'bullmq-job-1' });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeEnrichmentService,
        { provide: BridgeQueueService, useValue: { enqueueSagaJob: mockEnqueueSagaJob } },
        {
          provide: `LoggerService${BridgeEnrichmentService.name}`,
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

    service = module.get(BridgeEnrichmentService);
  });

  afterEach(() => vi.clearAllMocks());

  it('dispatches the enrich_via_pxe saga keyed by zoneId in the bullmq slot', async () => {
    await service.startEnrichment(ZONE_ID, BMC_IP, SEALED_BMC, PLAN_ID);

    expect(mockEnqueueSagaJob).toHaveBeenCalledOnce();
    const [zoneId, sagaName, planId, , bullmqDeviceKey] = mockEnqueueSagaJob.mock.calls[0];
    expect(zoneId).toBe(ZONE_ID);
    expect(sagaName).toBe('enrich_via_pxe');
    expect(planId).toBe(PLAN_ID);
    expect(bullmqDeviceKey).toBe(ZONE_ID);
  });

  it('builds the payload the bridge consumes: planId device_id, sealed bmc, reliable PXE boot', async () => {
    await service.startEnrichment(ZONE_ID, BMC_IP, SEALED_BMC, PLAN_ID);

    const [, , , payload] = mockEnqueueSagaJob.mock.calls[0];
    expect(payload).toEqual({
      bmc_ip: BMC_IP,
      device_id: PLAN_ID,
      secrets: { bmc: SEALED_BMC },
      command: 'reliable_boot',
      boot_device: 'pxe',
    });
    expect(payload.secrets.bmc).toBe(SEALED_BMC);
  });

  it('returns the planId on success', async () => {
    await expect(service.startEnrichment(ZONE_ID, BMC_IP, SEALED_BMC, PLAN_ID)).resolves.toEqual({
      success: true,
      planId: PLAN_ID,
    });
  });
});
