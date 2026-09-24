import { Test, TestingModule } from '@nestjs/testing';
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
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import { DeviceRecordPublisher } from '../../device-record/device-record-publisher.service';
import { DiscoveryIngressService } from '../../discovery/discovery-ingress.service';
import { JobLogWriterService } from '../../job-logs/job-log-writer.service';
import { BridgeCommissioningService } from '../../lifecycle/commissioning.service';
import { BridgeNetworkScanService } from '../../lifecycle/network-scan.service';
import { QualifyOrchestrationService } from '../../lifecycle/qualify-orchestration.service';
import { RenderRequestDispatcher } from '../../render-request/render-request-dispatcher.service';
import { BridgeResultsConsumer } from '../bridge-results.consumer';

const DEVICE_UUID = '550e8400-e29b-41d4-a716-446655440042';
const PLAN_ID = 'plan-tee-1';
const NEWER_PLAN_ID = 'plan-tee-2';
const PLAN_CREATED_AT = new Date('2026-09-17T10:00:00Z');
const NEWER_PLAN_CREATED_AT = new Date('2026-09-17T11:00:00Z');

function teeWrite(teeEnabled: boolean) {
  return { where: { deviceId: DEVICE_UUID, device: { deletedAt: null } }, data: { teeEnabled } };
}

function makeTeeConfigJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'job.result',
    data: {
      plan_id: PLAN_ID,
      step_name: 'tee_config',
      status: 'complete',
      device_id: DEVICE_UUID,
      zone_prefix: '1-1-1',
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
      plan_id: PLAN_ID,
      device_id: DEVICE_UUID,
      zone_prefix: '1-1-1',
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

describe('BridgeResultsConsumer — tee_config step results', () => {
  let consumer: BridgeResultsConsumer;
  let prisma: {
    device: { update: Mock; findUnique: Mock };
    server: { updateMany: Mock; createMany: Mock };
    job: { findUnique: Mock };
    lifecycleJob: { findUnique: Mock };
    operatingSystem: { findUnique: Mock };
  };
  let processResult: (job: unknown) => Promise<void>;
  let dispatchResult: (job: unknown) => Promise<unknown>;

  function teeEnabledWrites() {
    return prisma.server.updateMany.mock.calls.filter(([args]) => 'teeEnabled' in args.data);
  }

  beforeEach(async () => {
    prisma = {
      device: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue({ id: DEVICE_UUID }),
      },
      server: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      job: { findUnique: vi.fn() },
      lifecycleJob: {
        findUnique: vi.fn().mockResolvedValue({
          deviceId: DEVICE_UUID,
          createdAt: PLAN_CREATED_AT,
          payload: {
            operatingSystemSlug: 'ubuntu-noble-vanilla',
            request: { tee: true, operatingSystemSlug: 'ubuntu-noble-vanilla', customizations: null },
          },
        }),
      },
      operatingSystem: { findUnique: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeResultsConsumer,
        { provide: JobLogWriterService, useValue: { write: vi.fn() } },
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
        { provide: BridgeCommissioningService, useValue: { enqueueQualifyProvision: vi.fn() } },
        {
          provide: QualifyOrchestrationService,
          useValue: {
            isQualifyDevice: vi.fn().mockResolvedValue(false),
            handleQualifyFailure: vi.fn(),
            setPhoneHomeRunning: vi.fn(),
            handleQualifyDeprovisionComplete: vi.fn(),
          },
        },
        { provide: RenderRequestDispatcher, useValue: { dispatch: vi.fn() } },
        {
          provide: DeviceTokensService,
          useValue: { revokeBrokkrLiveTokensForDevice: vi.fn().mockResolvedValue(undefined) },
        },
        { provide: RedisPubSubService, useValue: { publish: vi.fn().mockResolvedValue(undefined) } },
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

    consumer = module.get(BridgeResultsConsumer);
    processResult = (consumer as any).processResult.bind(consumer);
    dispatchResult = (consumer as any).dispatchResult.bind(consumer);
  });

  it('records tee enabled after a verified enable', async () => {
    await processResult(makeTeeConfigJob({ result: { action: 'enabled', success: true } }));

    expect(prisma.server.updateMany).toHaveBeenCalledWith(teeWrite(true));
  });

  it('records tee disabled after a disable', async () => {
    await processResult(makeTeeConfigJob({ result: { action: 'disabled' } }));

    expect(prisma.server.updateMany).toHaveBeenCalledWith(teeWrite(false));
  });

  it('records tee enabled after a verified skip', async () => {
    await processResult(
      makeTeeConfigJob({ result: { skipped: true, reason: 'current=true, requested=true', success: true } }),
    );

    expect(prisma.server.updateMany).toHaveBeenCalledWith(teeWrite(true));
  });

  it('writes nothing for a skip without verification', async () => {
    await processResult(makeTeeConfigJob({ result: { skipped: true, reason: 'current=false, requested=false' } }));

    expect(teeEnabledWrites()).toEqual([]);
  });

  it('writes nothing for an enable that reports success false', async () => {
    await processResult(makeTeeConfigJob({ result: { action: 'enabled', success: false } }));

    expect(teeEnabledWrites()).toEqual([]);
  });

  it('writes nothing for a failed tee_config step', async () => {
    await processResult(
      makeTeeConfigJob({
        event_type: 'job_failed',
        status: 'failed',
        error: { message: 'enableTee failed: TEE was not enabled on the device' },
      }),
    );

    expect(teeEnabledWrites()).toEqual([]);
  });

  it('refuses a result whose plan is bound to another device', async () => {
    prisma.lifecycleJob.findUnique.mockResolvedValue({ deviceId: 'other-device', createdAt: PLAN_CREATED_AT });

    const outcome = await dispatchResult(makeTeeConfigJob({ result: { action: 'enabled', success: true } }));

    expect(String(outcome)).toBe('Symbol(bridge-results:handler-soft-fail)');
    expect(teeEnabledWrites()).toEqual([]);
  });

  it('writes nothing for a result from a superseded plan', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID, lastJobId: NEWER_PLAN_ID });
    prisma.lifecycleJob.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve({
        deviceId: DEVICE_UUID,
        createdAt: where.id === NEWER_PLAN_ID ? NEWER_PLAN_CREATED_AT : PLAN_CREATED_AT,
      }),
    );

    await processResult(makeTeeConfigJob({ result: { action: 'enabled', success: true } }));

    expect(teeEnabledWrites()).toEqual([]);
  });

  it('writes nothing for a tee_config result outside the provision saga', async () => {
    await processResult(makeTeeConfigJob({ action_type: 'deprovision', result: { action: 'disabled' } }));

    expect(teeEnabledWrites()).toEqual([]);
  });

  it('still reconciles to the requested state when the provision completes', async () => {
    await processResult(makeTeeConfigJob({ result: { action: 'enabled', success: true } }));
    await processResult(makeJobCompletedJob());

    expect(prisma.server.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.server.updateMany.mock.calls).toEqual([[teeWrite(true)], [teeWrite(true)]]);
  });
});
