import { Test, TestingModule } from '@nestjs/testing';
import { ServerPowerStatus } from '@repo/database';
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
const ZONE = '00000000-0000-0000-0000-111111111111';
const OTHER_ZONE = '00000000-0000-0000-0000-222222222222';

function makePhoneHomeJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'device.phone_home',
    data: {
      device_id: DEVICE_UUID,
      zone_prefix: ZONE,
      boot_id: 'boot-xyz',
      timestamp: Date.now(),
      ...overrides,
    },
  };
}

describe('BridgeResultsConsumer — Brokkr Live phone-home zone correlation', () => {
  let prisma: { device: { findUnique: Mock }; server: { updateMany: Mock; createMany: Mock } };
  let processResult: (job: unknown) => Promise<void>;

  beforeEach(async () => {
    prisma = {
      device: {
        findUnique: vi.fn().mockResolvedValue({ id: DEVICE_UUID, zoneId: ZONE }),
      },
      server: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
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
        { provide: RedisPubSubService, useValue: { publish: vi.fn().mockResolvedValue(undefined) } },
        {
          provide: LifecycleInboundService,
          useValue: { applyStepResult: vi.fn(), applyJobCompleted: vi.fn(), applyPhoneHome: vi.fn() },
        },
        { provide: DeviceRecordPublisher, useValue: { writeForDevice: vi.fn().mockResolvedValue({ written: true }) } },
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

  it('advances powerStatus to On when the device belongs to the message zone', async () => {
    await processResult(makePhoneHomeJob());

    expect(prisma.server.updateMany).toHaveBeenCalledWith({
      where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
      data: { powerStatus: ServerPowerStatus.On },
    });
  });

  it('refuses to mutate when the device belongs to a different zone (cross-tenant phone-home)', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID, zoneId: OTHER_ZONE });

    await processResult(makePhoneHomeJob({ zone_prefix: ZONE }));

    expect(prisma.server.updateMany).not.toHaveBeenCalled();
  });

  it('returns early for an unknown device without mutating', async () => {
    prisma.device.findUnique.mockResolvedValue(null);

    await processResult(makePhoneHomeJob());

    expect(prisma.server.updateMany).not.toHaveBeenCalled();
  });

  it('fails closed when the device has a null zoneId (cannot prove ownership)', async () => {
    prisma.device.findUnique.mockResolvedValue({ id: DEVICE_UUID, zoneId: null });

    await processResult(makePhoneHomeJob({ zone_prefix: ZONE }));

    expect(prisma.server.updateMany).not.toHaveBeenCalled();
  });
});
