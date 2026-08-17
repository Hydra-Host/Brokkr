import { BadRequestException, NotFoundException, NotImplementedException } from '@nestjs/common';
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
import { QualifyOrchestrationService } from '../../lifecycle/qualify-orchestration.service';
import { RenderRequestDispatcher } from '../../render-request/render-request-dispatcher.service';
import { BridgeResultsConsumer, type ProcessableJob } from '../bridge-results.consumer';

const BASE_ENVELOPE = {
  request_id: '11111111-1111-1111-1111-111111111111',
  zone_id: '22222222-2222-2222-2222-222222222222',
  bridge_id: 'bridge-a',
};

class TestableConsumer extends BridgeResultsConsumer {
  invoke(job: ProcessableJob): Promise<void> {
    return this.processResult(job);
  }
}

function makeRenderRequestJob(data: unknown): ProcessableJob {
  return { id: 'job-1', name: 'render.request', data };
}

describe('BridgeResultsConsumer — render.request', () => {
  let consumer: TestableConsumer;
  let dispatch: Mock;
  let loggerError: Mock;
  let loggerWarn: Mock;

  beforeEach(async () => {
    dispatch = vi.fn().mockResolvedValue(undefined);
    loggerError = vi.fn();
    loggerWarn = vi.fn();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: BridgeResultsConsumer, useClass: TestableConsumer },
        {
          provide: SealedEnvelopeService,
          useValue: { isZoneEnrolled: vi.fn().mockResolvedValue(false), openBridgeToHub: vi.fn() },
        },
        {
          provide: PrismaClient,
          useValue: { device: { update: vi.fn(), findUnique: vi.fn() }, job: { findUnique: vi.fn() } },
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
        {
          provide: QualifyOrchestrationService,
          useValue: { isQualifyDevice: vi.fn(), handleQualifyFailure: vi.fn() },
        },
        { provide: RenderRequestDispatcher, useValue: { dispatch } },
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
            warn: loggerWarn,
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

  const processResult = (job: ProcessableJob): Promise<void> => consumer.invoke(job);

  it('parses a valid envelope and forwards to the dispatcher', async () => {
    const data = {
      ...BASE_ENVELOPE,
      domain: 'netplan',
      params: { foo: 'bar' },
    };

    await processResult(makeRenderRequestJob(data));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ domain: 'netplan' }));
  });

  it('forwards a server_token render-request to the dispatcher with entity_id intact', async () => {
    const data = {
      ...BASE_ENVELOPE,
      domain: 'server_token',
      reason: 'missing',
      params: { entity_id: '442' },
    };

    await processResult(makeRenderRequestJob(data));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'server_token',
        params: { entity_id: '442' },
      }),
    );
  });

  it('logs and acks on malformed payload (no throw, no dispatcher call)', async () => {
    await expect(
      processResult(makeRenderRequestJob({ ...BASE_ENVELOPE, not: 'a render request' })),
    ).resolves.toBeUndefined();

    expect(dispatch).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(expect.stringMatching(/render\.request: invalid payload/));
  });

  it('acks (does not re-throw) when the dispatcher throws NotImplementedException', async () => {
    dispatch.mockRejectedValueOnce(new NotImplementedException('not yet'));

    const data = {
      ...BASE_ENVELOPE,
      domain: 'netplan',
      params: {},
    };

    await expect(processResult(makeRenderRequestJob(data))).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(/render\.request unfulfillable \(NotImplementedException\)/),
      BASE_ENVELOPE.request_id,
    );
  });

  it('acks (does not re-throw) when the dispatcher throws BadRequestException', async () => {
    dispatch.mockRejectedValueOnce(new BadRequestException('bad entity_id'));

    const data = {
      ...BASE_ENVELOPE,
      domain: 'netplan',
      params: {},
    };

    await expect(processResult(makeRenderRequestJob(data))).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(/render\.request unfulfillable \(BadRequestException\)/),
      BASE_ENVELOPE.request_id,
    );
  });

  it('acks (does not re-throw) when the dispatcher throws NotFoundException', async () => {
    dispatch.mockRejectedValueOnce(new NotFoundException('device disappeared'));

    const data = {
      ...BASE_ENVELOPE,
      domain: 'netplan',
      params: {},
    };

    await expect(processResult(makeRenderRequestJob(data))).resolves.toBeUndefined();
    expect(loggerWarn).toHaveBeenCalledWith(
      expect.stringMatching(/render\.request unfulfillable \(NotFoundException\)/),
      BASE_ENVELOPE.request_id,
    );
  });

  it('re-throws transient dispatcher errors so BullMQ can retry', async () => {
    dispatch.mockRejectedValueOnce(new Error('transient'));

    const data = {
      ...BASE_ENVELOPE,
      domain: 'netplan',
      params: {},
    };

    await expect(processResult(makeRenderRequestJob(data))).rejects.toThrow('transient');
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringMatching(/render\.request failed/),
      undefined,
      BASE_ENVELOPE.request_id,
    );
  });
});
