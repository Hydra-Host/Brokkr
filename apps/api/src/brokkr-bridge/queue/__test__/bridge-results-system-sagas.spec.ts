import { Test, TestingModule } from '@nestjs/testing';
import { SYSTEM_JOB_SAGAS } from '@repo/lifecycle';
import { REDIS_CLIENT, REDIS_CONFIG } from 'src/common/redis';
import { SealedEnvelopeService } from 'src/crypto/sealed-envelope.service';
import { DeviceSecretAuditService } from 'src/device-secret/device-secret-audit.service';
import { DeviceTestRunsService } from 'src/device-test-runs/device-test-runs.service';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { LifecycleInboundService } from 'src/lifecycle/inbound/lifecycle-inbound.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { SanitizationReportService } from 'src/sanitization-reports/sanitization-report.service';
import { ZoneCryptoConfig } from 'src/zone-crypto/zone-crypto.config';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DeviceRecordPublisher } from '../../device-record/device-record-publisher.service';
import { DiscoveryIngressService } from '../../discovery/discovery-ingress.service';
import { JobLogWriterService } from '../../job-logs/job-log-writer.service';
import { BridgeNetworkScanService } from '../../lifecycle/network-scan.service';
import { QualifyOrchestrationService } from '../../lifecycle/qualify-orchestration.service';
import { RenderRequestDispatcher } from '../../render-request/render-request-dispatcher.service';
import { BridgeResultsConsumer, type ProcessableJob } from '../bridge-results.consumer';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440077';
const PLAN = 'lifecycle-job-1';
const ZONE = 'zone-uuid-1';
const SYSTEM_SAGAS = Object.values(SYSTEM_JOB_SAGAS);

class TestableConsumer extends BridgeResultsConsumer {
  invoke(job: ProcessableJob): Promise<void> {
    return this.processResult(job);
  }
}

function stepResultJob(actionType: string): ProcessableJob {
  return {
    id: 'r1',
    name: 'job.result',
    data: {
      plan_id: PLAN,
      step_name: 'collect',
      status: 'running',
      device_id: DEVICE_UUID,
      zone_prefix: ZONE,
      event_type: 'stage_changed',
      action_type: actionType,
      result: null,
      error: null,
      attempt: 0,
      metadata: null,
      timestamp: Date.now(),
    },
  };
}

function jobCompletedJob(sagaName: string): ProcessableJob {
  return {
    id: 'c1',
    name: 'job.completed',
    data: {
      plan_id: PLAN,
      device_id: DEVICE_UUID,
      zone_prefix: ZONE,
      saga_name: sagaName,
      status: 'complete',
      duration_seconds: 3,
      error: null,
      metadata: null,
      timestamp: Date.now(),
    },
  };
}

describe('BridgeResultsConsumer — system sagas reach the lifecycle engine', () => {
  let consumer: TestableConsumer;
  let applyStepResult: Mock;
  let applyJobCompleted: Mock;
  let lifecycleJobFindUnique: Mock;
  let deviceFindUnique: Mock;
  let warn: Mock;

  beforeEach(async () => {
    applyStepResult = vi.fn().mockResolvedValue(true);
    applyJobCompleted = vi.fn().mockResolvedValue(true);
    lifecycleJobFindUnique = vi.fn().mockResolvedValue({ deviceId: DEVICE_UUID });
    deviceFindUnique = vi.fn().mockResolvedValue({ id: DEVICE_UUID });
    warn = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: BridgeResultsConsumer, useClass: TestableConsumer },
        { provide: JobLogWriterService, useValue: { write: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: SealedEnvelopeService,
          useValue: { isZoneEnrolled: vi.fn().mockResolvedValue(false), openBridgeToHub: vi.fn() },
        },
        {
          provide: PrismaClient,
          useValue: {
            device: {
              update: vi.fn().mockResolvedValue({}),
              findUnique: deviceFindUnique,
            },
            job: { findUnique: vi.fn().mockResolvedValue(null) },
            lifecycleJob: { findUnique: lifecycleJobFindUnique },
          },
        },
        {
          provide: REDIS_CONFIG,
          useValue: { host: 'localhost', port: 6379, password: '', tls: false, url: '', username: '' },
        },
        { provide: REDIS_CLIENT, useValue: { set: vi.fn(), get: vi.fn(), del: vi.fn() } },
        { provide: ZoneCryptoConfig, useValue: { privateKey: null } },
        { provide: DiscoveryIngressService, useValue: { handleDiscoveryComplete: vi.fn() } },
        { provide: BridgeNetworkScanService, useValue: { storeScanResult: vi.fn() } },
        { provide: DeviceTestRunsService, useValue: { update: vi.fn() } },
        { provide: SanitizationReportService, useValue: { createFromStepResult: vi.fn() } },
        {
          provide: QualifyOrchestrationService,
          useValue: { isQualifyDevice: vi.fn().mockResolvedValue(false), handleQualifyFailure: vi.fn() },
        },
        { provide: RenderRequestDispatcher, useValue: { dispatch: vi.fn() } },
        {
          provide: DeviceTokensService,
          useValue: { revokeBrokkrLiveTokensForDevice: vi.fn().mockResolvedValue(undefined) },
        },
        {
          provide: LifecycleInboundService,
          useValue: { applyStepResult, applyJobCompleted, applyPhoneHome: vi.fn() },
        },
        {
          provide: DeviceRecordPublisher,
          useValue: { writeForDevice: vi.fn().mockResolvedValue({ written: true }) },
        },
        { provide: DeviceSecretAuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: 'LoggerServiceBridgeResultsConsumer',
          useValue: {
            log: vi.fn(),
            warn,
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    consumer = module.get(BridgeResultsConsumer);
  });

  it.each(SYSTEM_SAGAS)('applies %s step results through the engine', async (saga) => {
    await consumer.invoke(stepResultJob(saga));

    expect(applyStepResult).toHaveBeenCalledWith(expect.objectContaining({ plan_id: PLAN, action_type: saga }));
  });

  it.each(SYSTEM_SAGAS)('applies %s completions through the engine', async (saga) => {
    await consumer.invoke(jobCompletedJob(saga));

    expect(applyJobCompleted).toHaveBeenCalledWith(expect.objectContaining({ plan_id: PLAN, saga_name: saga }));
  });

  it('leaves a network_scan completion to its own handler', async () => {
    await consumer.invoke(jobCompletedJob('network_scan'));

    expect(applyJobCompleted).not.toHaveBeenCalled();
  });

  describe('completion for a soft-deleted device', () => {
    beforeEach(() => {
      deviceFindUnique.mockResolvedValue(null);
    });

    it('still settles an inventory_collection job through the engine and warns', async () => {
      await consumer.invoke(jobCompletedJob('inventory_collection'));

      expect(applyJobCompleted).toHaveBeenCalledWith(
        expect.objectContaining({ plan_id: PLAN, saga_name: 'inventory_collection' }),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('settled only the lifecycle job'), PLAN);
    });

    it('still runs the plan correlation gate before settling a system saga', async () => {
      lifecycleJobFindUnique.mockResolvedValue({ deviceId: 'some-other-device' });

      await consumer.invoke(jobCompletedJob('inventory_collection'));

      expect(applyJobCompleted).not.toHaveBeenCalled();
    });

    it('drops a provision completion without reaching the engine', async () => {
      await consumer.invoke(jobCompletedJob('provision'));

      expect(applyJobCompleted).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropping job.completed'), PLAN);
    });
  });

  describe('plan ↔ device correlation without a legacy Job row', () => {
    it('correlates a plan known only to LifecycleJob and does not warn about a missing row', async () => {
      await consumer.invoke(stepResultJob('inventory_collection'));

      expect(lifecycleJobFindUnique).toHaveBeenCalledWith({ where: { id: PLAN }, select: { deviceId: true } });
      expect(applyStepResult).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('allowing without correlation check'), PLAN);
    });

    it('rejects a result whose LifecycleJob is bound to another device', async () => {
      lifecycleJobFindUnique.mockResolvedValue({ deviceId: 'some-other-device' });

      await consumer.invoke(stepResultJob('inventory_collection'));
      await consumer.invoke(jobCompletedJob('inventory_collection'));

      expect(applyStepResult).not.toHaveBeenCalled();
      expect(applyJobCompleted).not.toHaveBeenCalled();
    });

    it('warns and proceeds without a correlation check when neither table knows the plan', async () => {
      lifecycleJobFindUnique.mockResolvedValue(null);

      await consumer.invoke(stepResultJob('inventory_collection'));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('allowing without correlation check'), PLAN);
      expect(applyStepResult).toHaveBeenCalledOnce();
    });
  });
});
