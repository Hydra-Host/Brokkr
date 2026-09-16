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
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { DeviceRecordPublisher } from '../../device-record/device-record-publisher.service';
import { DiscoveryIngressService } from '../../discovery/discovery-ingress.service';
import { JobLogWriterService } from '../../job-logs/job-log-writer.service';
import { BridgeNetworkScanService } from '../../lifecycle/network-scan.service';
import { QualifyOrchestrationService } from '../../lifecycle/qualify-orchestration.service';
import { RenderRequestDispatcher } from '../../render-request/render-request-dispatcher.service';
import { BridgeResultsConsumer, type ProcessableJob } from '../bridge-results.consumer';

const ZONE = '00000000-0000-0000-0000-111111111111';
const OTHER_ZONE = '00000000-0000-0000-0000-222222222222';

class TestableConsumer extends BridgeResultsConsumer {
  invoke(job: ProcessableJob): Promise<void> {
    return this.processResult(job);
  }
}

describe('BridgeResultsConsumer — plaintext-after-activation gate', () => {
  let consumer: TestableConsumer;
  let isZoneEnrolled: Mock;
  let openBridgeToHub: Mock;
  let loggerError: Mock;

  beforeEach(async () => {
    isZoneEnrolled = vi.fn().mockResolvedValue(true);
    openBridgeToHub = vi.fn();
    loggerError = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: BridgeResultsConsumer, useClass: TestableConsumer },
        { provide: JobLogWriterService, useValue: { write: vi.fn() } },
        { provide: SealedEnvelopeService, useValue: { isZoneEnrolled, openBridgeToHub } },
        {
          provide: PrismaClient,
          useValue: {
            device: { findUnique: vi.fn().mockResolvedValue(null), update: vi.fn() },
            job: { findUnique: vi.fn().mockResolvedValue(null) },
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
        { provide: QualifyOrchestrationService, useValue: { isQualifyDevice: vi.fn(), handleQualifyFailure: vi.fn() } },
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
            warn: vi.fn(),
            error: loggerError,
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    consumer = module.get(BridgeResultsConsumer);
  });

  it('acks-without-retry plaintext job.result once the zone is sealed (permanent rejection, no retry loop)', async () => {
    const job: ProcessableJob = { id: 'r1', name: 'job.result', data: { zone_prefix: ZONE } };
    await expect(consumer.invoke(job)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('plaintext_after_activation'));
  });

  it('acks-without-retry plaintext device_health post-activation — it is sealed now (closes the forgery vector)', async () => {
    const job: ProcessableJob = {
      id: 'h1',
      name: 'device_health',
      data: { job_id: 'plan-1', device_id: 'dev-1', zone_prefix: ZONE },
    };
    await expect(consumer.invoke(job)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('plaintext_after_activation'));
  });

  it('gates every result type uniformly (job.completed too, not just job.result)', async () => {
    const job: ProcessableJob = { id: 'c1', name: 'job.completed', data: { zone_prefix: ZONE } };
    await expect(consumer.invoke(job)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('plaintext_after_activation'));
  });

  it('fails CLOSED on a gated plaintext result that omits its zone — even pre-activation', async () => {
    isZoneEnrolled.mockResolvedValue(false);
    const job: ProcessableJob = { id: 'r3', name: 'job.result', data: { status: 'x' } };
    await expect(consumer.invoke(job)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('missing_zone'));
  });

  it('acks-without-retry a sealed result whose body zone differs from the authenticated sender (cross-tenant forgery)', async () => {
    openBridgeToHub.mockResolvedValue({
      plaintext: Buffer.from(
        JSON.stringify({ zone_prefix: OTHER_ZONE, device_id: 'dev-x', boot_id: 'b', timestamp: 1 }),
      ),
      zoneId: ZONE,
    });
    const job: ProcessableJob = { id: 's1', name: 'device.phone_home', data: { envelope_v: 1 } };
    await expect(consumer.invoke(job)).resolves.toBeUndefined();
    expect(loggerError).toHaveBeenCalledWith(expect.stringContaining('body zone mismatch'));
  });

  it('accepts a sealed body whose zone matches the authenticated sender', async () => {
    openBridgeToHub.mockResolvedValue({
      plaintext: Buffer.from(JSON.stringify({ zone_prefix: ZONE, device_id: 'dev-x', boot_id: 'b', timestamp: 1 })),
      zoneId: ZONE,
    });
    const job: ProcessableJob = { id: 's2', name: 'device.phone_home', data: { envelope_v: 1 } };
    await expect(consumer.invoke(job)).resolves.toBeUndefined();
  });
});
