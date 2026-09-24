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
import { BridgeNetworkScanService } from '../../lifecycle/network-scan.service';
import { QualifyOrchestrationService } from '../../lifecycle/qualify-orchestration.service';
import { RenderRequestDispatcher } from '../../render-request/render-request-dispatcher.service';
import { BridgeResultsConsumer, type ProcessableJob } from '../bridge-results.consumer';
import { TestableConsumer } from './bridge-results-test-helpers';

const ZONE = '22222222-2222-2222-2222-222222222222';

describe('BridgeResultsConsumer — malformed payloads (D2a)', () => {
  let consumer: TestableConsumer;
  let loggerError: Mock;
  let discoveryIngress: { handleDiscoveryComplete: Mock };
  let lifecycleInbound: { applyStepResult: Mock; applyJobCompleted: Mock };
  let prismaDeviceFindUnique: Mock;

  beforeEach(async () => {
    loggerError = vi.fn();
    discoveryIngress = { handleDiscoveryComplete: vi.fn() };
    lifecycleInbound = {
      applyStepResult: vi.fn().mockResolvedValue(false),
      applyJobCompleted: vi.fn().mockResolvedValue(false),
    };
    prismaDeviceFindUnique = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: BridgeResultsConsumer, useClass: TestableConsumer },
        { provide: JobLogWriterService, useValue: { write: vi.fn() } },
        {
          provide: SealedEnvelopeService,
          useValue: { isZoneEnrolled: vi.fn().mockResolvedValue(false), openBridgeToHub: vi.fn() },
        },
        {
          provide: PrismaClient,
          useValue: {
            device: { update: vi.fn(), findUnique: prismaDeviceFindUnique },
            job: { findUnique: vi.fn() },
            lifecycleJob: { findUnique: vi.fn() },
            deviceHealthCheck: { create: vi.fn() },
            server: { updateMany: vi.fn() },
          },
        },
        {
          provide: REDIS_CONFIG,
          useValue: { host: 'localhost', port: 6379, password: '', tls: false, url: '', username: '' },
        },
        { provide: REDIS_CLIENT, useValue: { set: vi.fn(), get: vi.fn(), del: vi.fn() } },
        { provide: ZoneCryptoConfig, useValue: { privateKey: null } },
        { provide: DiscoveryIngressService, useValue: discoveryIngress },
        { provide: BridgeNetworkScanService, useValue: { storeScanResult: vi.fn() } },
        { provide: DeviceTestRunsService, useValue: { update: vi.fn() } },
        { provide: SanitizationReportService, useValue: { createFromStepResult: vi.fn() } },
        {
          provide: QualifyOrchestrationService,
          useValue: { isQualifyDevice: vi.fn(), handleQualifyFailure: vi.fn() },
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

  const cases: Array<{ name: string; log: RegExp; sideEffect?: () => void }> = [
    {
      name: 'discovery.complete',
      log: /discovery\.complete: invalid payload/,
      sideEffect: () => expect(discoveryIngress.handleDiscoveryComplete).not.toHaveBeenCalled(),
    },
    {
      name: 'job.result',
      log: /job\.result: invalid payload/,
      sideEffect: () => expect(lifecycleInbound.applyStepResult).not.toHaveBeenCalled(),
    },
    {
      name: 'job.completed',
      log: /job\.completed: invalid payload/,
      sideEffect: () => expect(lifecycleInbound.applyJobCompleted).not.toHaveBeenCalled(),
    },
    {
      name: 'device_health',
      log: /device_health: invalid payload/,
      sideEffect: () => expect(prismaDeviceFindUnique).not.toHaveBeenCalled(),
    },
    {
      name: 'device.phone_home',
      log: /device\.phone_home: invalid payload/,
      sideEffect: () => expect(prismaDeviceFindUnique).not.toHaveBeenCalled(),
    },
  ];

  for (const { name, log, sideEffect } of cases) {
    it(`${name}: logs and acks a malformed body without throwing`, async () => {
      const job: ProcessableJob = { id: 'job-1', name, data: { zone_prefix: ZONE, garbage: true } };

      await expect(consumer.invoke(job)).resolves.toBeUndefined();

      expect(loggerError).toHaveBeenCalledWith(expect.stringMatching(log));
      sideEffect?.();
    });
  }
});
