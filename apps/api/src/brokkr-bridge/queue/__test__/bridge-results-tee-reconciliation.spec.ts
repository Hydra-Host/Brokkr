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

function makeJobCompletedJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'job.completed',
    data: {
      plan_id: 'plan-tee-1',
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

describe('BridgeResultsConsumer — teeEnabled reconciliation', () => {
  let consumer: BridgeResultsConsumer;
  let prisma: {
    device: { update: Mock; findUnique: Mock };
    server: { updateMany: Mock; createMany: Mock };
    job: { findUnique: Mock };
    lifecycleJob: { findUnique: Mock };
    operatingSystem: { findUnique: Mock };
  };
  let processResult: (job: unknown) => Promise<void>;

  beforeEach(async () => {
    prisma = {
      device: {
        update: vi.fn().mockResolvedValue({}),
        findUnique: vi.fn().mockResolvedValue({ id: DEVICE_UUID }),
      },
      server: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      job: { findUnique: vi.fn() },
      lifecycleJob: { findUnique: vi.fn() },
      operatingSystem: { findUnique: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BridgeResultsConsumer,
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
  });

  describe('provision complete — reconcile teeEnabled', () => {
    it('sets teeEnabled=true when the provision requested TEE via the tee flag', async () => {
      prisma.lifecycleJob.findUnique.mockResolvedValue({
        payload: {
          operatingSystemSlug: 'ubuntu-noble-vanilla',
          request: { tee: true, operatingSystemSlug: 'ubuntu-noble-vanilla', customizations: null },
        },
      });

      await processResult(makeJobCompletedJob({ saga_name: 'provision', status: 'complete' }));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { teeEnabled: true },
      });
    });

    it('sets teeEnabled=true when the OS slug has a tee variant', async () => {
      prisma.lifecycleJob.findUnique.mockResolvedValue({
        payload: {
          operatingSystemSlug: 'ubuntu-noble-tee',
          request: { tee: false, operatingSystemSlug: 'ubuntu-noble-tee', customizations: null },
        },
      });

      await processResult(makeJobCompletedJob({ saga_name: 'provision', status: 'complete' }));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { teeEnabled: true },
      });
    });

    it('sets teeEnabled=true when customizations include tee-setup', async () => {
      prisma.lifecycleJob.findUnique.mockResolvedValue({
        payload: {
          operatingSystemSlug: 'ubuntu-noble-vanilla',
          request: {
            tee: false,
            operatingSystemSlug: 'ubuntu-noble-vanilla',
            customizations: ['tee-setup'],
          },
        },
      });

      await processResult(makeJobCompletedJob({ saga_name: 'provision', status: 'complete' }));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { teeEnabled: true },
      });
    });

    it('sets teeEnabled=false when no TEE was requested', async () => {
      prisma.lifecycleJob.findUnique.mockResolvedValue({
        payload: {
          operatingSystemSlug: 'ubuntu-noble-vanilla',
          request: { tee: false, operatingSystemSlug: 'ubuntu-noble-vanilla', customizations: null },
        },
      });

      await processResult(makeJobCompletedJob({ saga_name: 'provision', status: 'complete' }));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { teeEnabled: false },
      });
    });

    it('falls back to legacy Job when no LifecycleJob exists', async () => {
      prisma.lifecycleJob.findUnique.mockResolvedValue(null);
      prisma.job.findUnique.mockResolvedValue({
        deviceId: DEVICE_UUID,
        job: {
          operatingSystemSlug: 'ubuntu-noble-tee',
          request: { tee: false, operatingSystemSlug: 'ubuntu-noble-tee', customizations: null },
        },
      });

      await processResult(makeJobCompletedJob({ saga_name: 'provision', status: 'complete' }));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { teeEnabled: true },
      });
    });

    it('does not reconcile teeEnabled on provision failure', async () => {
      await processResult(makeJobCompletedJob({ saga_name: 'provision', status: 'failed' }));

      expect(prisma.server.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ teeEnabled: expect.anything() }) }),
      );
    });
  });

  describe('reprovision complete — reconcile teeEnabled from top-level payload', () => {
    it('sets teeEnabled=true when reprovision payload has tee=true at the top level', async () => {
      prisma.lifecycleJob.findUnique.mockResolvedValue({
        payload: {
          operatingSystemSlug: 'ubuntu-noble-vanilla',
          tee: true,
          customizations: null,
        },
      });

      await processResult(makeJobCompletedJob({ saga_name: 'provision', status: 'complete' }));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { teeEnabled: true },
      });
    });

    it('sets teeEnabled=true when reprovision payload has tee-setup in top-level customizations', async () => {
      prisma.lifecycleJob.findUnique.mockResolvedValue({
        payload: {
          operatingSystemSlug: 'ubuntu-noble-vanilla',
          tee: false,
          customizations: ['tee-setup'],
        },
      });

      await processResult(makeJobCompletedJob({ saga_name: 'provision', status: 'complete' }));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { teeEnabled: true },
      });
    });

    it('sets teeEnabled=false when reprovision payload has no TEE indicators', async () => {
      prisma.lifecycleJob.findUnique.mockResolvedValue({
        payload: {
          operatingSystemSlug: 'ubuntu-noble-vanilla',
          tee: false,
          customizations: null,
        },
      });

      await processResult(makeJobCompletedJob({ saga_name: 'provision', status: 'complete' }));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { teeEnabled: false },
      });
    });

    it('sets teeEnabled=true when reprovision OS slug has a tee variant', async () => {
      prisma.lifecycleJob.findUnique.mockResolvedValue({
        payload: {
          operatingSystemSlug: 'ubuntu-noble-tee',
          tee: false,
          customizations: null,
        },
      });

      await processResult(makeJobCompletedJob({ saga_name: 'provision', status: 'complete' }));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { teeEnabled: true },
      });
    });
  });

  describe('deprovision complete — leaves teeEnabled untouched', () => {
    it('does not write teeEnabled on successful deprovision', async () => {
      await processResult(makeJobCompletedJob({ saga_name: 'deprovision', status: 'complete' }));

      expect(prisma.server.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ teeEnabled: expect.anything() }) }),
      );
    });
  });
});
