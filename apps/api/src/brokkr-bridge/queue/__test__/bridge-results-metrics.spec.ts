import { Test, TestingModule } from '@nestjs/testing';
import { ServerLifecycleStatus } from '@repo/database';
import { REDIS_CLIENT, REDIS_CONFIG } from 'src/common/redis';
import { SealedEnvelopeService } from 'src/crypto/sealed-envelope.service';
import { SealOpenError } from 'src/crypto/sealed-envelope.types';
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

const { counterAdd, histogramRecord } = vi.hoisted(() => ({ counterAdd: vi.fn(), histogramRecord: vi.fn() }));
vi.mock('@repo/telemetry', () => ({
  getTelemetryMeter: () => ({
    createCounter: (name: string) => ({
      add: (value: number, attributes?: Record<string, unknown>) => counterAdd(name, value, attributes),
    }),
    createHistogram: (name: string) => ({
      record: (value: number, attributes?: Record<string, unknown>) => histogramRecord(name, value, attributes),
    }),
    createObservableGauge: () => ({ addCallback: vi.fn(), removeCallback: vi.fn() }),
  }),
  getBullMqTelemetry: () => undefined,
}));

const ZONE = '00000000-0000-0000-0000-111111111111';

class TestableConsumer extends BridgeResultsConsumer {
  invoke(job: ProcessableJob): Promise<void> {
    return this.processResult(job);
  }
}

describe('BridgeResultsConsumer — brokkr.bridge_results.processed outcomes', () => {
  let consumer: TestableConsumer;
  let openBridgeToHub: Mock;
  let deviceFindUnique: Mock;
  let deviceUpdate: Mock;
  let jobFindUnique: Mock;
  let healthCreate: Mock;
  let serverFindUnique: Mock;
  let serverUpdateMany: Mock;
  let serverCount: Mock;
  let serverCreateMany: Mock;
  let constructionAdds: unknown[][];

  beforeEach(async () => {
    counterAdd.mockClear();
    histogramRecord.mockClear();
    openBridgeToHub = vi.fn();
    deviceFindUnique = vi.fn().mockResolvedValue(null);
    deviceUpdate = vi.fn().mockResolvedValue({});
    jobFindUnique = vi.fn().mockResolvedValue(null);
    healthCreate = vi.fn().mockResolvedValue({});
    serverFindUnique = vi.fn().mockResolvedValue(null);
    serverUpdateMany = vi.fn().mockResolvedValue({ count: 0 });
    serverCount = vi.fn().mockResolvedValue(1);
    serverCreateMany = vi.fn().mockResolvedValue({ count: 0 });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: BridgeResultsConsumer, useClass: TestableConsumer },
        { provide: JobLogWriterService, useValue: { write: vi.fn() } },
        {
          provide: SealedEnvelopeService,
          useValue: { isZoneEnrolled: vi.fn().mockResolvedValue(true), openBridgeToHub },
        },
        {
          provide: PrismaClient,
          useValue: {
            device: { findUnique: deviceFindUnique, update: deviceUpdate },
            job: { findUnique: jobFindUnique },
            lifecycleJob: { findUnique: vi.fn().mockResolvedValue(null) },
            server: {
              findUnique: serverFindUnique,
              updateMany: serverUpdateMany,
              count: serverCount,
              createMany: serverCreateMany,
            },
            deviceHealthCheck: { create: healthCreate },
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
            error: vi.fn(),
            debug: vi.fn(),
            verbose: vi.fn(),
            setContext: vi.fn().mockReturnThis(),
          },
        },
      ],
    }).compile();

    consumer = module.get(BridgeResultsConsumer);
    constructionAdds = counterAdd.mock.calls.map((call) => [...call]);
    counterAdd.mockClear();
  });

  it('counts a permanent inbound-resolve rejection as outcome=error and acks-without-retry', async () => {
    const job: ProcessableJob = { id: 'r1', name: 'job.result', data: { zone_prefix: ZONE } };
    await expect(consumer.invoke(job)).resolves.toBeUndefined();
    expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.processed', 1, {
      kind: 'job.result',
      outcome: 'error',
    });
    expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.rejected', 1, {
      reason: 'plaintext_after_activation',
    });
  });

  it('counts an ack-without-retry device_health store failure as outcome=error', async () => {
    deviceFindUnique.mockResolvedValue({ id: 'dev-1' });
    healthCreate.mockRejectedValue(new Error('db down'));
    openBridgeToHub.mockResolvedValue({
      plaintext: Buffer.from(JSON.stringify({ job_id: 'j1', device_id: 'dev-1', zone_prefix: ZONE })),
      zoneId: ZONE,
    });
    const job: ProcessableJob = { id: 'h1', name: 'device_health', data: { envelope_v: 1 } };
    await expect(consumer.invoke(job)).resolves.toBeUndefined();
    expect(counterAdd).toHaveBeenCalledExactlyOnceWith('brokkr.bridge_results.processed', 1, {
      kind: 'device_health',
      outcome: 'error',
    });
  });

  it('counts a fully-handled result as outcome=ok, exactly once', async () => {
    openBridgeToHub.mockResolvedValue({
      plaintext: Buffer.from(JSON.stringify({ zone_prefix: ZONE, device_id: 'dev-x', boot_id: 'b', timestamp: 1 })),
      zoneId: ZONE,
    });
    const job: ProcessableJob = { id: 's1', name: 'device.phone_home', data: { envelope_v: 1 } };
    await expect(consumer.invoke(job)).resolves.toBeUndefined();
    expect(counterAdd).toHaveBeenCalledExactlyOnceWith('brokkr.bridge_results.processed', 1, {
      kind: 'device.phone_home',
      outcome: 'ok',
    });
  });

  it('accepts a blocked lock-wait result', async () => {
    openBridgeToHub.mockResolvedValue({
      plaintext: Buffer.from(
        JSON.stringify({
          plan_id: 'p1',
          step_name: 'lock_wait',
          status: 'blocked',
          device_id: 'dev-1',
          zone_prefix: ZONE,
          event_type: 'job_blocked',
          action_type: 'provision',
          timestamp: 1,
        }),
      ),
      zoneId: ZONE,
    });
    const job: ProcessableJob = { id: 'b1', name: 'job.result', data: { envelope_v: 1 } };

    await expect(consumer.invoke(job)).resolves.toBeUndefined();
    expect(counterAdd).toHaveBeenCalledExactlyOnceWith('brokkr.bridge_results.processed', 1, {
      kind: 'job.result',
      outcome: 'ok',
    });
  });

  describe('brokkr.bridge_results.rejected reasons', () => {
    it('counts a sealed body whose zone differs from the authenticated sender as zone_correlation', async () => {
      openBridgeToHub.mockResolvedValue({
        plaintext: Buffer.from(JSON.stringify({ zone_prefix: '00000000-0000-0000-0000-222222222222' })),
        zoneId: ZONE,
      });
      const job: ProcessableJob = { id: 'z1', name: 'job.result', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).resolves.toBeUndefined();
      expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.rejected', 1, { reason: 'zone_correlation' });
      expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.processed', 1, {
        kind: 'job.result',
        outcome: 'error',
      });
    });

    it('counts a sealed-envelope open failure under its stable seal reason', async () => {
      openBridgeToHub.mockRejectedValue(new SealOpenError('cryptographic open failed', { reason: 'open_failed' }));
      const job: ProcessableJob = { id: 'o1', name: 'job.result', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).rejects.toBeInstanceOf(SealOpenError);
      expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.rejected', 1, { reason: 'open_failed' });
      expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.processed', 1, {
        kind: 'job.result',
        outcome: 'error',
      });
    });

    it('counts unparseable opened plaintext as malformed_plaintext', async () => {
      openBridgeToHub.mockResolvedValue({ plaintext: Buffer.from('not-json'), zoneId: ZONE });
      const job: ProcessableJob = { id: 'p1', name: 'job.result', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).resolves.toBeUndefined();
      expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.rejected', 1, { reason: 'malformed_plaintext' });
      expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.processed', 1, {
        kind: 'job.result',
        outcome: 'error',
      });
    });

    it('does not count a transient resolve failure as a rejection', async () => {
      openBridgeToHub.mockRejectedValue(new Error('redis down'));
      const job: ProcessableJob = { id: 'e1', name: 'job.result', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).rejects.toThrow('redis down');
      expect(counterAdd).not.toHaveBeenCalledWith('brokkr.bridge_results.rejected', 1, expect.anything());
    });

    it('counts a phone-home for a device outside the sender zone as device_zone_mismatch', async () => {
      deviceFindUnique.mockResolvedValue({ id: 'dev-x', zoneId: '00000000-0000-0000-0000-333333333333' });
      openBridgeToHub.mockResolvedValue({
        plaintext: Buffer.from(JSON.stringify({ zone_prefix: ZONE, device_id: 'dev-x', boot_id: 'b', timestamp: 1 })),
        zoneId: ZONE,
      });
      const job: ProcessableJob = { id: 'd1', name: 'device.phone_home', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).resolves.toBeUndefined();
      expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.rejected', 1, { reason: 'device_zone_mismatch' });
      expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.processed', 1, {
        kind: 'device.phone_home',
        outcome: 'error',
      });
    });

    it('counts a plan bound to a different device as plan_device_mismatch', async () => {
      jobFindUnique.mockResolvedValue({ deviceId: 'someone-elses-device' });
      openBridgeToHub.mockResolvedValue({
        plaintext: Buffer.from(
          JSON.stringify({
            plan_id: 'p1',
            step_name: 'deploy_os',
            status: 'running',
            device_id: 'dev-1',
            zone_prefix: ZONE,
            event_type: 'stage_changed',
            action_type: 'provision',
            timestamp: 1,
          }),
        ),
        zoneId: ZONE,
      });
      const job: ProcessableJob = { id: 'm1', name: 'job.result', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).resolves.toBeUndefined();
      expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.rejected', 1, { reason: 'plan_device_mismatch' });
      expect(counterAdd).toHaveBeenCalledWith('brokkr.bridge_results.processed', 1, {
        kind: 'job.result',
        outcome: 'error',
      });
    });
  });

  describe('brokkr.saga.duration_seconds', () => {
    const completedBody = (over: Record<string, unknown> = {}) => ({
      plan_id: 'p1',
      device_id: 'dev-1',
      zone_prefix: ZONE,
      saga_name: 'provision',
      status: 'complete',
      timestamp: 1,
      ...over,
    });

    it('records the bridge-reported duration by saga name and status', async () => {
      openBridgeToHub.mockResolvedValue({
        plaintext: Buffer.from(JSON.stringify(completedBody({ duration_seconds: 42.5 }))),
        zoneId: ZONE,
      });
      const job: ProcessableJob = { id: 'c1', name: 'job.completed', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).resolves.toBeUndefined();
      expect(histogramRecord).toHaveBeenCalledExactlyOnceWith('brokkr.saga.duration_seconds', 42.5, {
        saga_name: 'provision',
        status: 'complete',
      });
    });

    it('skips the histogram when the completion carries no duration', async () => {
      openBridgeToHub.mockResolvedValue({
        plaintext: Buffer.from(JSON.stringify(completedBody())),
        zoneId: ZONE,
      });
      const job: ProcessableJob = { id: 'c2', name: 'job.completed', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).resolves.toBeUndefined();
      expect(histogramRecord).not.toHaveBeenCalled();
    });
  });

  describe('brokkr.device_lifecycle.transitions', () => {
    it('counts a saga-step failure lifecycle write with source=saga_result', async () => {
      deviceFindUnique.mockResolvedValue({ id: 'dev-1', lastJobId: null });
      serverUpdateMany.mockResolvedValue({ count: 1 });
      openBridgeToHub.mockResolvedValue({
        plaintext: Buffer.from(
          JSON.stringify({
            plan_id: 'p1',
            step_name: 'deploy_os',
            status: 'failed',
            device_id: 'dev-1',
            zone_prefix: ZONE,
            event_type: 'job_failed',
            action_type: 'provision',
            timestamp: 1,
            error: { message: 'boom' },
          }),
        ),
        zoneId: ZONE,
      });
      const job: ProcessableJob = { id: 't1', name: 'job.result', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).resolves.toBeUndefined();
      expect(deviceUpdate).toHaveBeenCalled();
      expect(counterAdd).toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, {
        to_status: ServerLifecycleStatus.FAILED,
        source: 'saga_result',
      });
    });

    it('does not count a same-status re-write (e.g. job.completed after the failed step) as a transition', async () => {
      deviceFindUnique.mockResolvedValue({ id: 'dev-1', lastJobId: null });
      serverUpdateMany.mockResolvedValue({ count: 0 });
      openBridgeToHub.mockResolvedValue({
        plaintext: Buffer.from(
          JSON.stringify({
            plan_id: 'p1',
            device_id: 'dev-1',
            zone_prefix: ZONE,
            saga_name: 'provision',
            status: 'failed',
            timestamp: 1,
          }),
        ),
        zoneId: ZONE,
      });
      const job: ProcessableJob = { id: 't2', name: 'job.completed', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).resolves.toBeUndefined();
      expect(deviceUpdate).toHaveBeenCalled();
      expect(counterAdd).not.toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, expect.anything());
    });

    it('counts the first write that materializes a missing server row (created-as-failed must alert)', async () => {
      deviceFindUnique.mockResolvedValue({ id: 'dev-1', lastJobId: null });
      serverUpdateMany.mockResolvedValue({ count: 0 });
      serverCreateMany.mockResolvedValue({ count: 1 });
      openBridgeToHub.mockResolvedValue({
        plaintext: Buffer.from(
          JSON.stringify({
            plan_id: 'p1',
            device_id: 'dev-1',
            zone_prefix: ZONE,
            saga_name: 'provision',
            status: 'failed',
            timestamp: 1,
          }),
        ),
        zoneId: ZONE,
      });
      const job: ProcessableJob = { id: 't2b', name: 'job.completed', data: { envelope_v: 1 } };
      await expect(consumer.invoke(job)).resolves.toBeUndefined();
      expect(counterAdd).toHaveBeenCalledWith('brokkr.device_lifecycle.transitions', 1, {
        to_status: 'FAILED',
        source: 'saga_completed',
      });
    });

    it('dedups a raced duplicate lifecycle write — only the row-changing write counts', async () => {
      deviceFindUnique.mockResolvedValue({ id: 'dev-1', lastJobId: null });
      serverUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
      openBridgeToHub.mockResolvedValue({
        plaintext: Buffer.from(
          JSON.stringify({
            plan_id: 'p1',
            step_name: 'deploy_os',
            status: 'failed',
            device_id: 'dev-1',
            zone_prefix: ZONE,
            event_type: 'job_failed',
            action_type: 'provision',
            timestamp: 1,
            error: { message: 'boom' },
          }),
        ),
        zoneId: ZONE,
      });
      const job: ProcessableJob = { id: 't3', name: 'job.result', data: { envelope_v: 1 } };
      await consumer.invoke(job);
      await consumer.invoke(job);

      const transitionAdds = counterAdd.mock.calls.filter(
        ([name, value]) => name === 'brokkr.device_lifecycle.transitions' && value === 1,
      );
      expect(transitionAdds).toHaveLength(1);
    });

    it('pre-registers the FAILED series at zero so alert rate()/increase() sees the first failure', () => {
      expect(constructionAdds).toContainEqual([
        'brokkr.device_lifecycle.transitions',
        0,
        { to_status: ServerLifecycleStatus.FAILED, source: 'saga_result' },
      ]);
      expect(constructionAdds).toContainEqual([
        'brokkr.device_lifecycle.transitions',
        0,
        { to_status: ServerLifecycleStatus.FAILED, source: 'saga_completed' },
      ]);
    });
  });
});
