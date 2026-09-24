import { Test, TestingModule } from '@nestjs/testing';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { REDIS_CLIENT, REDIS_CONFIG } from 'src/common/redis';
import { SealedEnvelopeService } from 'src/crypto/sealed-envelope.service';
import { DeviceSecretAuditService } from 'src/device-secret/device-secret-audit.service';
import { DeviceTestRunsService } from 'src/device-test-runs/device-test-runs.service';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { RedisPubSubService } from 'src/events/redis-pubsub.service';
import { LifecycleInboundService } from 'src/lifecycle/inbound/lifecycle-inbound.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { SanitizationReportService } from 'src/sanitization-reports/sanitization-report.service';
import { ZoneCryptoConfig } from 'src/zone-crypto/zone-crypto.config';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DeviceRecordPublisher } from '../../device-record/device-record-publisher.service';
import { DiscoveryIngressService } from '../../discovery/discovery-ingress.service';
import { JobLogWriterService } from '../../job-logs/job-log-writer.service';
import { BridgeNetworkScanService } from '../../lifecycle/network-scan.service';
import { QualifyOrchestrationService } from '../../lifecycle/qualify-orchestration.service';
import { RenderRequestDispatcher } from '../../render-request/render-request-dispatcher.service';
import { BridgeResultsConsumer } from '../bridge-results.consumer';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';
const ZONE = 'zone-uuid-1';
const PLAN = 'plan-1';

function makeStepResultJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'job.result',
    data: {
      plan_id: PLAN,
      step_name: 'deploy_os',
      status: 'running',
      device_id: DEVICE_UUID,
      zone_prefix: ZONE,
      event_type: 'stage_changed',
      action_type: 'provision',
      result: null,
      error: null,
      attempt: 0,
      metadata: null,
      timestamp: Date.now(),
      ...overrides,
    },
  };
}

function makeJobCompletedJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'job.completed',
    data: {
      plan_id: PLAN,
      device_id: DEVICE_UUID,
      zone_prefix: ZONE,
      saga_name: 'provision',
      status: 'complete',
      duration_seconds: 10,
      error: null,
      metadata: null,
      timestamp: Date.now(),
      ...overrides,
    },
  };
}

describe('BridgeResultsConsumer — job log writes', () => {
  let jobLogWriter: { write: Mock };
  let lifecycleInbound: { applyStepResult: Mock; applyJobCompleted: Mock; applyPhoneHome: Mock };
  let jobFindUnique: Mock;
  let deviceFindUnique: Mock;
  let findByIdUnscoped: ReturnType<typeof vi.spyOn>;
  let processResult: (job: unknown) => Promise<void>;

  beforeEach(async () => {
    jobLogWriter = { write: vi.fn().mockResolvedValue(undefined) };
    jobFindUnique = vi.fn().mockResolvedValue({ deviceId: DEVICE_UUID });
    deviceFindUnique = vi.fn().mockResolvedValue({ id: DEVICE_UUID, zoneId: ZONE });
    findByIdUnscoped = vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(null);
    lifecycleInbound = {
      applyStepResult: vi.fn().mockResolvedValue(false),
      applyJobCompleted: vi.fn().mockResolvedValue(false),
      applyPhoneHome: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeResultsConsumer,
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
            server: {
              updateMany: vi.fn().mockResolvedValue({ count: 1 }),
              createMany: vi.fn().mockResolvedValue({ count: 0 }),
            },
            job: { findUnique: jobFindUnique },
            operatingSystem: { findUnique: vi.fn() },
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
        { provide: RedisPubSubService, useValue: { publish: vi.fn().mockResolvedValue(undefined) } },
        { provide: LifecycleInboundService, useValue: lifecycleInbound },
        {
          provide: DeviceRecordPublisher,
          useValue: { writeForDevice: vi.fn().mockResolvedValue({ written: true }) },
        },
        { provide: DeviceSecretAuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        { provide: JobLogWriterService, useValue: jobLogWriter },
        {
          provide: 'LoggerServiceBridgeResultsConsumer',
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

    const consumer = module.get(BridgeResultsConsumer);
    processResult = (consumer as unknown as { processResult: (job: unknown) => Promise<void> }).processResult.bind(
      consumer,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('handleStepResult', () => {
    it('writes an error line with the failure message on job_failed', async () => {
      await processResult(makeStepResultJob({ event_type: 'job_failed', error: { message: 'disk on fire' } }));

      expect(jobLogWriter.write).toHaveBeenCalledWith(
        ZONE,
        PLAN,
        'error',
        'Step deploy_os failed (saga provision): disk on fire',
        'BridgeResultsConsumer',
      );
    });

    it('falls back to unknown when job_failed carries no error', async () => {
      await processResult(makeStepResultJob({ event_type: 'job_failed', error: null }));

      expect(jobLogWriter.write).toHaveBeenCalledWith(
        ZONE,
        PLAN,
        'error',
        'Step deploy_os failed (saga provision): unknown',
        'BridgeResultsConsumer',
      );
    });

    it('writes an info line on stage_changed', async () => {
      await processResult(makeStepResultJob({ event_type: 'stage_changed', status: 'running' }));

      expect(jobLogWriter.write).toHaveBeenCalledWith(
        ZONE,
        PLAN,
        'info',
        'Step deploy_os: running',
        'BridgeResultsConsumer',
      );
    });

    it('writes an info line on job_blocked before the early return', async () => {
      await processResult(makeStepResultJob({ event_type: 'job_blocked', status: 'blocked' }));

      expect(jobLogWriter.write).toHaveBeenCalledWith(
        ZONE,
        PLAN,
        'info',
        'Step deploy_os: blocked',
        'BridgeResultsConsumer',
      );
      expect(lifecycleInbound.applyStepResult).not.toHaveBeenCalled();
    });
  });

  describe('handleJobCompleted', () => {
    it('writes an info line when the saga status is complete', async () => {
      await processResult(makeJobCompletedJob({ status: 'complete' }));

      expect(jobLogWriter.write).toHaveBeenCalledWith(
        ZONE,
        PLAN,
        'info',
        'Saga provision completed: complete',
        'BridgeResultsConsumer',
      );
    });

    it('writes an error line for any non-complete saga status', async () => {
      await processResult(makeJobCompletedJob({ status: 'failed' }));

      expect(jobLogWriter.write).toHaveBeenCalledWith(
        ZONE,
        PLAN,
        'error',
        'Saga provision completed: failed',
        'BridgeResultsConsumer',
      );
    });

    it('does not write a log line on an attempt that fails before handling settles', async () => {
      lifecycleInbound.applyJobCompleted.mockRejectedValue(new Error('db down'));

      await expect(processResult(makeJobCompletedJob())).rejects.toThrow('db down');
      expect(jobLogWriter.write).not.toHaveBeenCalled();
    });

    it('writes exactly one log line once a retried attempt succeeds', async () => {
      lifecycleInbound.applyJobCompleted.mockRejectedValueOnce(new Error('db down'));

      await expect(processResult(makeJobCompletedJob())).rejects.toThrow('db down');
      await processResult(makeJobCompletedJob());

      expect(jobLogWriter.write).toHaveBeenCalledExactlyOnceWith(
        ZONE,
        PLAN,
        'info',
        'Saga provision completed: complete',
        'BridgeResultsConsumer',
      );
    });
  });

  describe('saga-keyed suppression', () => {
    it('drops the step and completion lines for the inventory collection saga', async () => {
      await processResult(makeStepResultJob({ action_type: 'inventory_collection' }));
      await processResult(makeJobCompletedJob({ saga_name: 'inventory_collection' }));

      expect(jobLogWriter.write).not.toHaveBeenCalled();
      expect(findByIdUnscoped).not.toHaveBeenCalled();
    });

    it('keeps the step and completion lines for the benchmarks saga', async () => {
      await processResult(makeStepResultJob({ action_type: 'benchmarks', step_name: 'run_gpu_burn' }));
      await processResult(makeJobCompletedJob({ saga_name: 'benchmarks' }));

      expect(jobLogWriter.write).toHaveBeenCalledWith(
        ZONE,
        PLAN,
        'info',
        'Step run_gpu_burn: running',
        'BridgeResultsConsumer',
      );
      expect(jobLogWriter.write).toHaveBeenCalledWith(
        ZONE,
        PLAN,
        'info',
        'Saga benchmarks completed: complete',
        'BridgeResultsConsumer',
      );
    });
  });

  describe('zone/plan trust derivation', () => {
    it('writes under the hub-resolved zone, ignoring the bridge-supplied zone_prefix', async () => {
      await processResult(makeStepResultJob({ zone_prefix: 'forged-zone' }));

      expect(jobLogWriter.write).toHaveBeenCalledWith(
        ZONE,
        PLAN,
        'info',
        'Step deploy_os: running',
        'BridgeResultsConsumer',
      );
    });

    it('writes the step line for a lifecycle plan id that has no legacy Job row', async () => {
      findByIdUnscoped.mockResolvedValue({ data: { deviceId: DEVICE_UUID } });
      jobFindUnique.mockResolvedValue(null);

      await processResult(makeStepResultJob({ status: 'complete' }));

      expect(findByIdUnscoped).toHaveBeenCalledWith(PLAN);
      expect(jobLogWriter.write).toHaveBeenCalledWith(
        ZONE,
        PLAN,
        'info',
        'Step deploy_os: complete',
        'BridgeResultsConsumer',
      );
    });

    it('drops the log write when the lifecycle plan is bound to a different device', async () => {
      findByIdUnscoped.mockResolvedValue({ data: { deviceId: 'other-device' } });
      jobFindUnique.mockResolvedValue(null);

      await processResult(makeStepResultJob());

      expect(jobLogWriter.write).not.toHaveBeenCalled();
      expect(deviceFindUnique).not.toHaveBeenCalledWith({ where: { id: 'other-device' }, select: { zoneId: true } });
    });

    it('drops the log write when neither a LifecycleJob nor a Job row exists for the plan', async () => {
      jobFindUnique.mockResolvedValue(null);

      await processResult(makeStepResultJob());

      expect(jobLogWriter.write).not.toHaveBeenCalled();
    });

    it('drops the log write when the legacy plan is bound to a different device', async () => {
      jobFindUnique.mockResolvedValue({ deviceId: 'other-device' });

      await processResult(makeJobCompletedJob());

      expect(jobLogWriter.write).not.toHaveBeenCalled();
    });

    it('drops the log write when the plan is not device-bound', async () => {
      jobFindUnique.mockResolvedValue({ deviceId: null });

      await processResult(makeStepResultJob());

      expect(jobLogWriter.write).not.toHaveBeenCalled();
    });

    it('drops the log write when the device has no zone', async () => {
      deviceFindUnique.mockResolvedValue({ id: DEVICE_UUID, zoneId: null });

      await processResult(makeJobCompletedJob());

      expect(jobLogWriter.write).not.toHaveBeenCalled();
    });
  });
});
