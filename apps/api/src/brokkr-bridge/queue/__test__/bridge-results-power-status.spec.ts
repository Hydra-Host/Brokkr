import { Test, TestingModule } from '@nestjs/testing';
import { ServerPowerStatus } from '@repo/database';
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

function makeStepResultJob(overrides: Record<string, unknown> = {}) {
  return {
    name: 'job.result',
    data: {
      plan_id: 'plan-1',
      step_name: 'power_on',
      status: 'running',
      device_id: DEVICE_UUID,
      zone_prefix: '1-1-1',
      event_type: 'stage_changed',
      action_type: 'reboot',
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
      plan_id: 'plan-1',
      device_id: DEVICE_UUID,
      zone_prefix: '1-1-1',
      saga_name: 'reboot',
      status: 'complete',
      duration_seconds: 10,
      error: null,
      metadata: null,
      timestamp: Date.now(),
      ...overrides,
    },
  };
}

describe('BridgeResultsConsumer — power status updates', () => {
  let consumer: BridgeResultsConsumer;
  let prisma: {
    device: { update: Mock; findUnique: Mock };
    server: { updateMany: Mock; createMany: Mock };
    job: { findUnique: Mock };
    operatingSystem: { findUnique: Mock };
    deviceHealthCheck: { create: Mock };
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
      },
      job: { findUnique: vi.fn() },
      operatingSystem: { findUnique: vi.fn() },
      deviceHealthCheck: { create: vi.fn().mockResolvedValue({}) },
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

    consumer = module.get(BridgeResultsConsumer);
    processResult = (consumer as any).processResult.bind(consumer);
  });

  describe('step result power status updates', () => {
    it('updates powerStatus to PoweringOn on power_on step running', async () => {
      await processResult(
        makeStepResultJob({
          action_type: 'reboot',
          step_name: 'power_on',
          status: 'running',
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: ServerPowerStatus.PoweringOn },
      });
    });

    it('updates powerStatus to PoweringOff on power_off step running', async () => {
      await processResult(
        makeStepResultJob({
          action_type: 'reboot',
          step_name: 'power_off',
          status: 'running',
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: ServerPowerStatus.PoweringOff },
      });
    });

    it('updates powerStatus to Off on verify_power_off step complete', async () => {
      await processResult(
        makeStepResultJob({
          action_type: 'reboot',
          step_name: 'verify_power_off',
          status: 'complete',
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: ServerPowerStatus.Off },
      });
    });

    it('updates for power_on saga', async () => {
      await processResult(
        makeStepResultJob({
          action_type: 'power_on',
          step_name: 'power_on',
          status: 'running',
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: ServerPowerStatus.PoweringOn },
      });
    });

    it('updates for power_off saga', async () => {
      await processResult(
        makeStepResultJob({
          action_type: 'power_off',
          step_name: 'power_off',
          status: 'running',
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: ServerPowerStatus.PoweringOff },
      });
    });

    it('does not update for unmapped step names', async () => {
      await processResult(
        makeStepResultJob({
          action_type: 'reboot',
          step_name: 'some_unknown_step',
          status: 'running',
        }),
      );

      expect(prisma.server.updateMany).not.toHaveBeenCalled();
    });

    it('silently no-ops when the device has no Server row (updateMany count=0, never creates one)', async () => {
      prisma.server.updateMany.mockResolvedValueOnce({ count: 0 });

      await expect(
        processResult(makeStepResultJob({ action_type: 'reboot', step_name: 'power_on', status: 'running' })),
      ).resolves.toBeUndefined();

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: ServerPowerStatus.PoweringOn },
      });
    });
  });

  describe('handleJobCompleted updates', () => {
    it('clears powerStatus to unknown on reboot failure', async () => {
      await processResult(
        makeJobCompletedJob({
          saga_name: 'reboot',
          status: 'failed',
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: null },
      });
    });

    it('does NOT update powerStatus on successful reboot (relies on phone-home)', async () => {
      await processResult(
        makeJobCompletedJob({
          saga_name: 'reboot',
          status: 'complete',
        }),
      );

      expect(prisma.server.updateMany).not.toHaveBeenCalled();
    });

    it('does NOT update powerStatus on successful power_on (relies on phone-home)', async () => {
      await processResult(
        makeJobCompletedJob({
          saga_name: 'power_on',
          status: 'complete',
        }),
      );

      expect(prisma.server.updateMany).not.toHaveBeenCalled();
    });

    it('sets Off on successful power_off', async () => {
      await processResult(
        makeJobCompletedJob({
          saga_name: 'power_off',
          status: 'complete',
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: ServerPowerStatus.Off },
      });
    });

    it('clears powerStatus to unknown on power_on failure', async () => {
      await processResult(
        makeJobCompletedJob({
          saga_name: 'power_on',
          status: 'failed',
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: null },
      });
    });

    it('clears powerStatus to unknown on power_off failure', async () => {
      await processResult(
        makeJobCompletedJob({
          saga_name: 'power_off',
          status: 'failed',
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: null },
      });
    });
  });

  describe('plan_id correlation (C11)', () => {
    it('refuses to mutate when plan is bound to a different device', async () => {
      prisma.job.findUnique.mockResolvedValue({
        deviceId: 'other-device-uuid',
      });

      await processResult(
        makeJobCompletedJob({
          saga_name: 'power_off',
          status: 'complete',
          device_id: DEVICE_UUID,
        }),
      );

      expect(prisma.server.updateMany).not.toHaveBeenCalled();
    });

    it('proceeds when plan and device match', async () => {
      prisma.job.findUnique.mockResolvedValue({
        deviceId: DEVICE_UUID,
      });

      await processResult(
        makeJobCompletedJob({
          saga_name: 'power_off',
          status: 'complete',
          device_id: DEVICE_UUID,
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: { deviceId: DEVICE_UUID, device: { deletedAt: null } },
        data: { powerStatus: ServerPowerStatus.Off },
      });
    });

    it('allows a zone-level Job with no device binding', async () => {
      prisma.job.findUnique.mockResolvedValue({
        deviceId: null,
      });

      await processResult(
        makeJobCompletedJob({
          saga_name: 'power_off',
          status: 'complete',
        }),
      );

      expect(prisma.server.updateMany).toHaveBeenCalled();
    });
  });

  describe('device_health power status sync', () => {
    const makeHealthJob = (poweredOn: boolean | null) => ({
      name: 'device_health',
      data: {
        job_id: 'health-1',
        device_id: DEVICE_UUID,
        zone_prefix: '1-1-1',
        powered_on: poweredOn,
      },
    });

    it('syncs powerStatus from a health check, the only writer for a device that never runs a power op', async () => {
      await processResult(makeHealthJob(true));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: {
          deviceId: DEVICE_UUID,
          device: { deletedAt: null },
          OR: [{ powerStatus: { not: ServerPowerStatus.On } }, { powerStatus: null }],
        },
        data: { powerStatus: ServerPowerStatus.On },
      });
    });

    it('writes Off when the health check reports the box down', async () => {
      await processResult(makeHealthJob(false));

      expect(prisma.server.updateMany).toHaveBeenCalledWith({
        where: {
          deviceId: DEVICE_UUID,
          device: { deletedAt: null },
          OR: [{ powerStatus: { not: ServerPowerStatus.Off } }, { powerStatus: null }],
        },
        data: { powerStatus: ServerPowerStatus.Off },
      });
    });

    it.each([
      ['On', true, ServerPowerStatus.On],
      ['Off', false, ServerPowerStatus.Off],
    ])(
      'matches a never-observed row whose powerStatus is still null when reporting %s, so a new device is not stranded',
      async (_label, poweredOn, expected) => {
        await processResult(makeHealthJob(poweredOn));

        const { where } = prisma.server.updateMany.mock.calls[0][0];
        expect(where.OR).toContainEqual({ powerStatus: null });
        expect(where.OR).toContainEqual({ powerStatus: { not: expected } });
        expect(where).not.toHaveProperty('powerStatus');
      },
    );

    it('leaves powerStatus alone when the health check could not determine it', async () => {
      await processResult(makeHealthJob(null));

      expect(prisma.deviceHealthCheck.create).toHaveBeenCalled();
      expect(prisma.server.updateMany).not.toHaveBeenCalled();
    });
  });
});
