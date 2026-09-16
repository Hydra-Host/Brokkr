import { Test, TestingModule } from '@nestjs/testing';
import { JobStatus, JobType } from '@repo/database';
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
import { BridgeResultsConsumer } from '../bridge-results.consumer';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';
/** In production plan_id = Job.id = device UUID. */
const PLAN = DEVICE_UUID;
const ZONE = 'zone-uuid-1';

function makeStepResultJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'job.result',
    data: {
      plan_id: PLAN,
      step_name: 'disk_wipe',
      status: 'complete',
      device_id: DEVICE_UUID,
      zone_prefix: ZONE,
      event_type: 'stage_changed',
      action_type: 'commission',
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
      saga_name: 'commission',
      status: 'complete',
      duration_seconds: 10,
      error: null,
      metadata: null,
      timestamp: Date.now(),
      ...overrides,
    },
  };
}

describe('BridgeResultsConsumer — Commission Job lifecycle', () => {
  let prisma: {
    device: { update: Mock; findUnique: Mock };
    server: { updateMany: Mock; createMany: Mock; findUnique: Mock };
    job: { findUnique: Mock; updateMany: Mock };
  };
  let processResult: (job: unknown) => Promise<void>;

  beforeEach(async () => {
    prisma = {
      device: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue({ id: DEVICE_UUID }),
      },
      server: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUnique: vi.fn().mockResolvedValue({ lifecycleStatus: 'FAILED' }),
      },
      job: {
        findUnique: vi.fn().mockResolvedValue({ deviceId: DEVICE_UUID, device: { zoneId: ZONE } }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeResultsConsumer,
        { provide: JobLogWriterService, useValue: { write: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: SealedEnvelopeService,
          useValue: { isZoneEnrolled: vi.fn().mockResolvedValue(false), openBridgeToHub: vi.fn() },
        },
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

  it('marks the Commission Job Completed when the wipe saga finishes', async () => {
    await processResult(makeJobCompletedJob({ saga_name: 'commission', status: 'complete' }));

    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: PLAN,
        jobType: JobType.Commission,
        status: { in: [JobStatus.Pending, JobStatus.InProgress] },
      },
      data: { status: JobStatus.Completed },
    });
  });

  it('marks the Commission Job Failed when the wipe saga fails', async () => {
    await processResult(
      makeJobCompletedJob({ saga_name: 'commission', status: 'failed', error: { message: 'bmc unreachable' } }),
    );

    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: PLAN,
        jobType: JobType.Commission,
        status: { in: [JobStatus.Pending, JobStatus.InProgress] },
      },
      data: { status: JobStatus.Failed, error: 'bmc unreachable' },
    });
  });

  it('marks the Commission Job Failed on a commission job_failed step result', async () => {
    await processResult(
      makeStepResultJob({
        event_type: 'job_failed',
        status: 'failed',
        step_name: 'ipmi_validation',
        error: { message: 'bmc auth failed' },
      }),
    );

    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: PLAN,
        jobType: JobType.Commission,
        status: { in: [JobStatus.Pending, JobStatus.InProgress] },
      },
      data: { status: JobStatus.Failed, error: 'bmc auth failed' },
    });
  });

  it('marks the Commission Job InProgress with lastCompletedStep on stage_changed complete', async () => {
    await processResult(
      makeStepResultJob({
        event_type: 'stage_changed',
        status: 'complete',
        step_name: 'disk_wipe',
      }),
    );

    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: PLAN,
        jobType: JobType.Commission,
        status: { in: [JobStatus.Pending, JobStatus.InProgress] },
      },
      data: { status: JobStatus.InProgress, lastCompletedStep: 'disk_wipe' },
    });
  });

  it('marks the Commission Job InProgress without lastCompletedStep on stage_changed running', async () => {
    await processResult(
      makeStepResultJob({
        event_type: 'stage_changed',
        status: 'running',
        step_name: 'disk_wipe',
      }),
    );

    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: PLAN,
        jobType: JobType.Commission,
        status: { in: [JobStatus.Pending, JobStatus.InProgress] },
      },
      data: { status: JobStatus.InProgress },
    });
  });

  it('does not settle the Commission Job when the plan/device gate skips', async () => {
    prisma.job.findUnique.mockRejectedValue(new Error('db down'));

    await processResult(
      makeStepResultJob({
        event_type: 'stage_changed',
        status: 'complete',
        step_name: 'disk_wipe',
      }),
    );

    expect(prisma.job.updateMany).not.toHaveBeenCalled();
  });

  it('rethrows when a terminal Commission Job settle fails', async () => {
    prisma.job.updateMany.mockRejectedValue(new Error('db down'));

    await expect(processResult(makeJobCompletedJob({ saga_name: 'commission', status: 'complete' }))).rejects.toThrow(
      'db down',
    );
  });

  it('accepts a terminal Commission Job settle no-op (already settled)', async () => {
    prisma.job.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      processResult(makeJobCompletedJob({ saga_name: 'commission', status: 'complete' })),
    ).resolves.toBeUndefined();
    expect(prisma.job.updateMany).toHaveBeenCalledWith({
      where: {
        id: PLAN,
        jobType: JobType.Commission,
        status: { in: [JobStatus.Pending, JobStatus.InProgress] },
      },
      data: { status: JobStatus.Completed },
    });
  });
});
