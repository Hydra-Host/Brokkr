import { Test, TestingModule } from '@nestjs/testing';
import { ServerLifecycleStatus } from '@repo/database';
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

function makeDeprovisionFailed(planId: string) {
  return {
    name: 'job.completed',
    data: {
      plan_id: planId,
      device_id: DEVICE_UUID,
      zone_prefix: '1-1-1',
      saga_name: 'deprovision',
      status: 'failed',
      duration_seconds: 1,
      error: { message: 'boom' },
      metadata: null,
      timestamp: Date.now(),
    },
  };
}

describe('BridgeResultsConsumer — monotonic lifecycle application', () => {
  let consumer: BridgeResultsConsumer;
  let prisma: {
    device: { update: Mock; findUnique: Mock };
    job: { findUnique: Mock; updateMany: Mock };
    lifecycleJob: { findUnique: Mock };
    server: { findUnique: Mock; updateMany: Mock; count: Mock; createMany: Mock };
  };
  let loggerWarn: Mock;
  let qualifyHandleFailure: Mock;
  let processResult: (job: unknown) => Promise<void>;

  beforeEach(async () => {
    loggerWarn = vi.fn();
    qualifyHandleFailure = vi.fn();
    prisma = {
      device: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
      job: { findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      lifecycleJob: { findUnique: vi.fn().mockResolvedValue(null) },
      server: {
        findUnique: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        count: vi.fn().mockResolvedValue(1),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
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
        {
          provide: QualifyOrchestrationService,
          useValue: { isQualifyDevice: vi.fn().mockResolvedValue(false), handleQualifyFailure: qualifyHandleFailure },
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
        { provide: DeviceRecordPublisher, useValue: { writeForDevice: vi.fn().mockResolvedValue({ written: true }) } },
        { provide: DeviceSecretAuditService, useValue: { record: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: 'LoggerServiceBridgeResultsConsumer',
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

    consumer = module.get(BridgeResultsConsumer);
    processResult = (consumer as any).processResult.bind(consumer);
  });

  it('skips a lifecycle write whose plan predates the device’s last applied job (stale replay)', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID, lastJobId: 'plan-new' });
    prisma.job.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'plan-old')
        return Promise.resolve({ deviceId: DEVICE_UUID, createdAt: new Date('2026-01-01T00:00:00Z') });
      if (where.id === 'plan-new')
        return Promise.resolve({ deviceId: DEVICE_UUID, createdAt: new Date('2026-01-02T00:00:00Z') });
      return Promise.resolve(null);
    });

    await processResult(makeDeprovisionFailed('plan-old'));

    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('Skipping stale lifecycle write'), 'plan-old');
  });

  it('treats an engine-written lastJobId (LifecycleJob id, no Job row) as newer — replayed legacy write is skipped', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID, lastJobId: 'lj-new' });
    prisma.job.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'plan-old')
        return Promise.resolve({ deviceId: DEVICE_UUID, createdAt: new Date('2026-01-01T00:00:00Z') });
      return Promise.resolve(null);
    });
    prisma.lifecycleJob.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'lj-new') return Promise.resolve({ createdAt: new Date('2026-01-02T00:00:00Z') });
      return Promise.resolve(null);
    });

    await processResult(makeDeprovisionFailed('plan-old'));

    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('Skipping stale lifecycle write'), 'plan-old');
  });

  it('applies a lifecycle write whose plan is the latest (forward transition)', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID, lastJobId: 'plan-old' });
    prisma.job.findUnique.mockImplementation(({ where }: { where: { id: string } }) => {
      if (where.id === 'plan-old')
        return Promise.resolve({ deviceId: DEVICE_UUID, createdAt: new Date('2026-01-01T00:00:00Z') });
      if (where.id === 'plan-new')
        return Promise.resolve({ deviceId: DEVICE_UUID, createdAt: new Date('2026-01-02T00:00:00Z') });
      return Promise.resolve(null);
    });

    await processResult(makeDeprovisionFailed('plan-new'));

    expect(prisma.device.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: DEVICE_UUID, deletedAt: null } }),
    );
  });

  it('applies the first lifecycle write when the device has no prior applied job', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID, lastJobId: null });
    prisma.job.findUnique.mockResolvedValue({ deviceId: DEVICE_UUID, createdAt: new Date('2026-01-01T00:00:00Z') });

    await processResult(makeDeprovisionFailed('plan-1'));

    expect(prisma.device.update).toHaveBeenCalled();
  });

  function makeCommissionFailed() {
    return {
      name: 'job.completed',
      data: {
        plan_id: DEVICE_UUID,
        device_id: DEVICE_UUID,
        zone_prefix: '1-1-1',
        saga_name: 'commission',
        status: 'failed',
        duration_seconds: 1,
        error: { message: 'boom' },
        metadata: null,
        timestamp: Date.now(),
      },
    };
  }

  it('ignores a superseded commission failure once qualify has advanced the reused device (PROVISIONING)', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID, lastJobId: null });
    prisma.server.updateMany.mockResolvedValue({ count: 0 });
    prisma.server.findUnique.mockResolvedValue({ lifecycleStatus: ServerLifecycleStatus.PROVISIONING });

    await processResult(makeCommissionFailed());

    expect(prisma.server.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ deviceId: DEVICE_UUID }),
      }),
    );
    expect(qualifyHandleFailure).not.toHaveBeenCalled();
  });

  it('applies an commission failure when the device has not advanced past FAILED (genuine failure)', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID, lastJobId: null });
    prisma.server.updateMany.mockResolvedValue({ count: 1 });

    await processResult(makeCommissionFailed());

    expect(prisma.server.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { lifecycleStatus: ServerLifecycleStatus.FAILED },
      }),
    );
    expect(prisma.device.update).toHaveBeenCalledWith(expect.objectContaining({ data: { lastJobId: DEVICE_UUID } }));
    expect(qualifyHandleFailure).toHaveBeenCalledWith(DEVICE_UUID, 'Commission saga failed');
  });
});
