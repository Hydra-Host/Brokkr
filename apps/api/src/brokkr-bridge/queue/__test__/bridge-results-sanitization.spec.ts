import { Test, TestingModule } from '@nestjs/testing';
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
import { BridgeNetworkScanService } from '../../lifecycle/network-scan.service';
import { BridgeCommissioningService } from '../../lifecycle/commissioning.service';
import { QualifyOrchestrationService } from '../../lifecycle/qualify-orchestration.service';
import { RenderRequestDispatcher } from '../../render-request/render-request-dispatcher.service';
import { BridgeResultsConsumer } from '../bridge-results.consumer';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';

function makeReport(overrides: Record<string, unknown> = {}) {
  return {
    version: '1.0',
    standards_reference: ['NIST SP 800-88r2'],
    job_id: 'job-123',
    mode: 'full',
    started_at: '2026-06-21T00:00:00.000Z',
    completed_at: '2026-06-21T00:01:00.000Z',
    duration_seconds: 12.5,
    overall_result: 'pass',
    tool: { name: 'nwipe', version: '0.36' },
    holder_teardown: {},
    disks: [],
    preserved_disks: [],
    skipped_disks: [],
    ...overrides,
  };
}

function makeWipeJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'job.result',
    data: {
      plan_id: 'plan-1',
      step_name: 'wipe_disks',
      status: 'complete',
      device_id: DEVICE_UUID,
      zone_prefix: '1-1-1',
      event_type: 'stage_changed',
      action_type: 'provision',
      result: { sanitization_report: makeReport() },
      error: null,
      attempt: 0,
      metadata: null,
      timestamp: Date.now(),
      ...overrides,
    },
  };
}

describe('BridgeResultsConsumer — sanitization report persistence', () => {
  let consumer: BridgeResultsConsumer;
  let prisma: { device: { update: Mock; findUnique: Mock }; job: { findUnique: Mock } };
  let sanitization: { createFromStepResult: Mock };
  let logger: { warn: Mock; error: Mock; log: Mock; debug: Mock; verbose: Mock; setContext: Mock };
  let processResult: (job: unknown) => Promise<void>;

  beforeEach(async () => {
    prisma = {
      device: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue({ id: DEVICE_UUID }),
      },
      job: { findUnique: vi.fn().mockResolvedValue({ deviceId: DEVICE_UUID }) },
    };
    sanitization = { createFromStepResult: vi.fn().mockResolvedValue(undefined) };
    logger = {
      warn: vi.fn(),
      error: vi.fn(),
      log: vi.fn(),
      debug: vi.fn(),
      verbose: vi.fn(),
      setContext: vi.fn().mockReturnThis(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeResultsConsumer,
        { provide: PrismaClient, useValue: prisma },
        {
          provide: REDIS_CONFIG,
          useValue: { host: 'localhost', port: 6379, password: '', tls: false, url: '', username: '' },
        },
        { provide: REDIS_CLIENT, useValue: { set: vi.fn(), get: vi.fn(), del: vi.fn() } },
        { provide: ZoneCryptoConfig, useValue: { privateKey: null } },
        { provide: DiscoveryIngressService, useValue: { handleDiscoveryComplete: vi.fn() } },
        { provide: BridgeNetworkScanService, useValue: { storeScanResult: vi.fn() } },
        { provide: DeviceTestRunsService, useValue: { update: vi.fn() } },
        { provide: SanitizationReportService, useValue: sanitization },
        {
          provide: SealedEnvelopeService,
          useValue: { isZoneEnrolled: vi.fn().mockResolvedValue(false), openBridgeToHub: vi.fn() },
        },
        { provide: BridgeCommissioningService, useValue: { enqueueQualifyProvision: vi.fn() } },
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
          useValue: {
            applyStepResult: vi.fn().mockResolvedValue(false),
            applyJobCompleted: vi.fn().mockResolvedValue(false),
            applyPhoneHome: vi.fn(),
          },
        },
        {
          provide: DeviceRecordPublisher,
          useValue: { writeForDevice: vi.fn().mockResolvedValue({ written: true }) },
        },
        { provide: DeviceSecretAuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        { provide: 'LoggerServiceBridgeResultsConsumer', useValue: logger },
      ],
    }).compile();

    consumer = module.get(BridgeResultsConsumer);
    processResult = (consumer as any).processResult.bind(consumer);
  });

  it("persists the report for the provision 'wipe_disks' step", async () => {
    await processResult(makeWipeJob({ action_type: 'provision', step_name: 'wipe_disks' }));
    expect(sanitization.createFromStepResult).toHaveBeenCalledTimes(1);
    expect(sanitization.createFromStepResult).toHaveBeenCalledWith(
      DEVICE_UUID,
      'provision',
      expect.objectContaining({ job_id: 'job-123' }),
      'plan-1',
    );
  });

  it("persists the report for the deprovision 'disk_wipe' step", async () => {
    await processResult(makeWipeJob({ action_type: 'deprovision', step_name: 'disk_wipe' }));
    expect(sanitization.createFromStepResult).toHaveBeenCalledWith(
      DEVICE_UUID,
      'deprovision',
      expect.objectContaining({ job_id: 'job-123' }),
      'plan-1',
    );
  });

  it("persists the report for the commission 'disk_wipe' step", async () => {
    await processResult(makeWipeJob({ action_type: 'commission', step_name: 'disk_wipe' }));
    expect(sanitization.createFromStepResult).toHaveBeenCalledWith(
      DEVICE_UUID,
      'commission',
      expect.objectContaining({ job_id: 'job-123' }),
      'plan-1',
    );
  });

  it('skips persistence when the plan is bound to a different device', async () => {
    prisma.job.findUnique.mockResolvedValue({ deviceId: 'other-device-uuid' });
    await processResult(makeWipeJob({ step_name: 'disk_wipe', action_type: 'deprovision' }));
    expect(sanitization.createFromStepResult).not.toHaveBeenCalled();
  });

  it('skips persistence on a non-complete status', async () => {
    await processResult(makeWipeJob({ status: 'running' }));
    expect(sanitization.createFromStepResult).not.toHaveBeenCalled();
  });

  it('persists a FAILED report on the job_failed path (the compliance-critical one)', async () => {
    await processResult(
      makeWipeJob({
        status: 'failed',
        event_type: 'job_failed',
        error: { message: 'Disk wipe failed: sanitization failed' },
        result: { sanitization_report: makeReport({ overall_result: 'fail' }) },
      }),
    );
    expect(sanitization.createFromStepResult).toHaveBeenCalledWith(
      DEVICE_UUID,
      'provision',
      expect.objectContaining({ overall_result: 'fail' }),
      'plan-1',
    );
  });

  it('persists the bridge tolerant failure shape {mode:full, overall_result:fail} (must not drop)', async () => {
    await processResult(
      makeWipeJob({
        status: 'failed',
        event_type: 'job_failed',
        error: { message: 'Disk wipe failed: sanitization failed' },
        result: { sanitization_report: { mode: 'full', overall_result: 'fail' } },
      }),
    );
    expect(sanitization.createFromStepResult).toHaveBeenCalledTimes(1);
    expect(sanitization.createFromStepResult).toHaveBeenCalledWith(
      DEVICE_UUID,
      'provision',
      expect.objectContaining({ mode: 'full', overall_result: 'fail' }),
      'plan-1',
    );
  });

  it('rejects a non-object report shape (array) without throwing', async () => {
    await processResult(makeWipeJob({ result: { sanitization_report: ['not', 'an', 'object'] } }));
    expect(sanitization.createFromStepResult).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('swallows a persist failure so sibling step-result work is not aborted', async () => {
    sanitization.createFromStepResult.mockRejectedValue(new Error('prisma boom'));
    await expect(processResult(makeWipeJob({ step_name: 'disk_wipe', action_type: 'commission' }))).resolves.not.toThrow();
    expect(logger.error).toHaveBeenCalled();
  });
});
