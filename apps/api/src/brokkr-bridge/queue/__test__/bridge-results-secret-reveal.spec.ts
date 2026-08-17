import { Test, TestingModule } from '@nestjs/testing';
import { DeviceSecretAuditEventType, DeviceSecretActorType, DeviceSecretKind, DeviceSecretPurpose } from '@repo/database';
import { Buffer } from 'node:buffer';
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
import { QualifyOrchestrationService } from '../../lifecycle/qualify-orchestration.service';
import { RenderRequestDispatcher } from '../../render-request/render-request-dispatcher.service';
import { BridgeResultsConsumer, type ProcessableJob } from '../bridge-results.consumer';

class TestableConsumer extends BridgeResultsConsumer {
  invoke(job: ProcessableJob): Promise<void> {
    return this.processResult(job);
  }
}

describe('BridgeResultsConsumer — secret.revealed audit', () => {
  let consumer: TestableConsumer;
  let auditRecord: Mock;
  let redisSet: Mock;
  let findFirst: Mock;

  beforeEach(async () => {
    auditRecord = vi.fn().mockResolvedValue(undefined);
    redisSet = vi.fn().mockResolvedValue('OK');
    findFirst = vi.fn().mockResolvedValue({
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      version: 4,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: BridgeResultsConsumer, useClass: TestableConsumer },
        { provide: SealedEnvelopeService, useValue: { isZoneEnrolled: vi.fn().mockResolvedValue(false), openBridgeToHub: vi.fn() } },
        {
          provide: PrismaClient,
          useValue: {
            device: { findUnique: vi.fn().mockResolvedValue({ zoneId: 'zone-9' }) },
            deviceSecretAuditEvent: { findFirst },
          },
        },
        {
          provide: REDIS_CONFIG,
          useValue: { host: 'localhost', port: 6379, password: '', tls: false, url: '', username: '' },
        },
        { provide: REDIS_CLIENT, useValue: { set: redisSet, get: vi.fn(), del: vi.fn() } },
        { provide: ZoneCryptoConfig, useValue: { privateKey: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8') } },
        { provide: DiscoveryIngressService, useValue: { handleDiscoveryComplete: vi.fn() } },
        { provide: BridgeNetworkScanService, useValue: { storeScanResult: vi.fn() } },
        { provide: DeviceTestRunsService, useValue: { update: vi.fn() } },
        { provide: SanitizationReportService, useValue: { createFromStepResult: vi.fn() } },
        { provide: QualifyOrchestrationService, useValue: { isQualifyDevice: vi.fn(), handleQualifyFailure: vi.fn() } },
        { provide: RenderRequestDispatcher, useValue: { dispatch: vi.fn() } },
        { provide: DeviceTokensService, useValue: { revokeBrokkrLiveTokensForDevice: vi.fn() } },
        {
          provide: LifecycleInboundService,
          useValue: { applyStepResult: vi.fn(), applyJobCompleted: vi.fn(), applyPhoneHome: vi.fn() },
        },
        { provide: DeviceRecordPublisher, useValue: { writeForDevice: vi.fn() } },
        { provide: DeviceSecretAuditService, useValue: { record: auditRecord } },
        {
          provide: 'LoggerServiceBridgeResultsConsumer',
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn(), setContext: vi.fn().mockReturnThis() },
        },
      ],
    }).compile();

    consumer = module.get(BridgeResultsConsumer);
  });

  it('stashes the reply and records a BRIDGE-actor REVEAL_DELIVERED correlated by requestId', async () => {
    const job: ProcessableJob = {
      id: 's1',
      name: 'secret.revealed',
      data: { zone_prefix: 'zone-9', request_id: 'req-7', device_id: 'dev-1', secret: { user: 'admin', pass: 'p' } },
    };

    await consumer.invoke(job);

    expect(redisSet).toHaveBeenCalledOnce();
    expect(findFirst).toHaveBeenCalledOnce();
    expect(auditRecord).toHaveBeenCalledOnce();
    const input = auditRecord.mock.calls[0][0];
    expect(input).toMatchObject({
      deviceId: 'dev-1',
      event: DeviceSecretAuditEventType.REVEAL_DELIVERED,
      purpose: DeviceSecretPurpose.BMC,
      kind: DeviceSecretKind.USER,
      version: 4,
      requestId: 'req-7',
      actor: { type: DeviceSecretActorType.BRIDGE, id: 'zone-9' },
    });
  });
});
