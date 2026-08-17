import {
  BadRequestException,
  forwardRef,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  DeviceSecretActorType,
  DeviceSecretAuditEventType,
  DeviceTokenRevocationReason,
  ServerLifecycleStatus,
  ServerPowerStatus,
} from '@repo/database';
import { powerWordToServerPowerStatus, statusSlugToServerLifecycle } from '@repo/device-domain';
import { type ObservableGaugeCallback, getBullMqTelemetry, getTelemetryMeter } from '@repo/telemetry';
import { isRecord } from '@repo/utils';
import { type Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Buffer } from 'node:buffer';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { type RedisTransportConnectionConfig, REDIS_CLIENT, REDIS_CONFIG } from 'src/common/redis';
import { SealedEnvelopeService } from 'src/crypto/sealed-envelope.service';
import { isSealedEnvelope, SealOpenError } from 'src/crypto/sealed-envelope.types';
import {
  REVEAL_STASH_TTL_SECONDS,
  revealStashAad,
  revealStashKey,
} from 'src/device-secret/device-secret-access.service';
import { DeviceSecretAuditService } from 'src/device-secret/device-secret-audit.service';
import { deriveStashKey, encryptStash } from 'src/device-secret/reveal-stash.crypto';
import { DeviceTestRunsService } from 'src/device-test-runs/device-test-runs.service';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { LifecycleInboundService } from 'src/lifecycle/inbound/lifecycle-inbound.service';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { SanitizationReportService } from 'src/sanitization-reports/sanitization-report.service';
import { createDeviceLifecycleTransitionsCounter } from 'src/telemetry/domain-metrics';
import { ZoneCryptoConfig } from 'src/zone-crypto/zone-crypto.config';
import { z } from 'zod';
import { QUEUE_JOB_STATES, RESULTS_PREFIX, RESULTS_QUEUE_NAME } from '../constants/queue.constants';
import { DeviceRecordPublisher } from '../device-record/device-record-publisher.service';
import { DiscoveryIngressService } from '../discovery/discovery-ingress.service';
import { discoveryCompleteDataSchema } from '../discovery/discovery.types';
import { BridgeNetworkScanService } from '../lifecycle/network-scan.service';
import { QualifyOrchestrationService } from '../lifecycle/qualify-orchestration.service';
import { isTeeRequested } from '../lifecycle/tee-requested';
import { RenderRequestDispatcher } from '../render-request/render-request-dispatcher.service';
import { renderRequestSchema } from '../types/render-request.types';
import {
  type JobCompletedData,
  type JobResultData,
  benchmarkStepResultSchema,
  deviceHealthDataSchema,
  isResultJobName,
  jobCompletedDataSchema,
  jobResultDataSchema,
  phoneHomeDataSchema,
  RESULT_JOB_NAME,
  sanitizationReportSchema,
  WIPE_STEP_NAMES,
} from './bridge-queue.types';

export type ProcessableJob = Pick<Job, 'id' | 'name' | 'data'>;

const LIFECYCLE_ENGINE_SAGAS: ReadonlySet<string> = new Set([
  'provision',
  'deprovision',
  'reboot',
  'power_on',
  'power_off',
]);

const HANDLER_SOFT_FAIL: unique symbol = Symbol('bridge-results:handler-soft-fail');

// plan↔device correlation gate: `proceed` runs the mutation; `skip` leaves it alone (no Job / check couldn't
// run); `reject` is a forged/misrouted result → refuse AND surface outcome=error (caller returns HANDLER_SOFT_FAIL).
type PlanDeviceGate = 'proceed' | 'skip' | 'reject';

@Injectable()
export class BridgeResultsConsumer implements OnModuleInit, OnModuleDestroy {
  private worker: Worker | null = null;
  // Count-only handle for the same results queue the worker consumes — Worker
  // exposes no job-count reads, so the gauge needs its own Queue.
  private resultsQueue: Queue | null = null;

  private readonly resultsProcessed = getTelemetryMeter('brokkr-hub').createCounter('brokkr.bridge_results.processed', {
    description: 'Bridge results consumed from results:inbox, by result kind and outcome',
  });
  private readonly sagasCompleted = getTelemetryMeter('brokkr-hub').createCounter('brokkr.saga.completed', {
    description: 'Saga completions reported by bridges, by saga name and status',
  });
  private readonly lifecycleTransitions = createDeviceLifecycleTransitionsCounter();
  private readonly sagaDurationSeconds = getTelemetryMeter('brokkr-hub').createHistogram(
    'brokkr.saga.duration_seconds',
    { description: 'Bridge-reported saga duration in seconds, by saga name and status' },
  );
  private readonly resultsRejected = getTelemetryMeter('brokkr-hub').createCounter('brokkr.bridge_results.rejected', {
    description: 'Bridge results rejected by inbound trust gates, by reason',
  });
  private readonly queueJobs = getTelemetryMeter('brokkr-hub').createObservableGauge('brokkr.queue.jobs', {
    description: 'BullMQ job counts by queue and state',
  });

  // Stored so onModuleDestroy can unregister it before closing the queue.
  private readonly observeResultsQueue: ObservableGaugeCallback = async (observable) => {
    const queue = this.resultsQueue;
    if (!queue) return;
    try {
      const counts = await queue.getJobCounts(...QUEUE_JOB_STATES);
      for (const state of QUEUE_JOB_STATES) {
        observable.observe(counts[state] ?? 0, { queue: `${RESULTS_PREFIX}:${RESULTS_QUEUE_NAME}`, state });
      }
    } catch (error) {
      // Swallow: a dead Redis must not fail the metrics collection cycle.
      this.logger.debug(`queue.jobs gauge: failed to read results inbox counts: ${getErrorMessage(error)}`);
    }
  };

  constructor(
    @Inject(REDIS_CONFIG) private readonly redisConfig: RedisTransportConnectionConfig,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly prisma: PrismaClient,
    private readonly discoveryIngress: DiscoveryIngressService,
    private readonly networkScanService: BridgeNetworkScanService,
    private readonly deviceTestRunsService: DeviceTestRunsService,
    private readonly sanitizationReportService: SanitizationReportService,
    private readonly qualifyOrchestration: QualifyOrchestrationService,
    private readonly renderRequestDispatcher: RenderRequestDispatcher,
    private readonly deviceRecordPublisher: DeviceRecordPublisher,
    private readonly deviceTokensService: DeviceTokensService,
    @Inject(forwardRef(() => LifecycleInboundService))
    private readonly lifecycleInbound: LifecycleInboundService,
    private readonly sealedEnvelope: SealedEnvelopeService,
    private readonly zoneCryptoConfig: ZoneCryptoConfig,
    @Inject(forwardRef(() => DeviceSecretAuditService))
    private readonly deviceSecretAudit: DeviceSecretAuditService,
    @Logger(BridgeResultsConsumer.name) private readonly logger: LoggerService,
  ) {
    // Pre-register the alerted-on series at zero: increase()/rate() can't see a series' birth, so
    // without this the first FAILED transition after a hub restart never fires the saga-failures alert.
    this.lifecycleTransitions.add(0, { to_status: ServerLifecycleStatus.FAILED, source: 'saga_result' });
    this.lifecycleTransitions.add(0, { to_status: ServerLifecycleStatus.FAILED, source: 'saga_completed' });
  }

  onModuleInit() {
    this.worker = new Worker(RESULTS_QUEUE_NAME, async (job: Job) => this.processResult(job), {
      prefix: RESULTS_PREFIX,
      connection: { ...this.redisConfig },
      concurrency: 20,
      telemetry: getBullMqTelemetry('brokkr-hub'),
    });

    this.worker.on('failed', (job, error) => {
      this.logger.error(`Results job failed: ${job?.id}: ${error.message}`);
    });

    this.resultsQueue = new Queue(RESULTS_QUEUE_NAME, {
      prefix: RESULTS_PREFIX,
      connection: { ...this.redisConfig },
    });
    this.queueJobs.addCallback(this.observeResultsQueue);

    this.logger.log(
      `Bridge results consumer started (prefix=${RESULTS_PREFIX}, redis=${this.redisConfig.host}:${this.redisConfig.port})`,
    );
  }

  async onModuleDestroy() {
    this.queueJobs.removeCallback(this.observeResultsQueue);
    if (this.resultsQueue) {
      await this.resultsQueue.close();
      this.resultsQueue = null;
    }
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }

  protected async processResult(job: ProcessableJob) {
    let resolved: ProcessableJob;
    try {
      resolved = await this.resolveInboundData(job);
    } catch (error) {
      const reason = inboundRejectionReason(error);
      if (reason !== null) this.resultsRejected.add(1, { reason });
      // Inbound rejections (envelope open, zone correlation) land in the error rate too — the name
      // survives sealing, so the kind label matches what a successful resolve would have recorded.
      this.resultsProcessed.add(1, { kind: job.name, outcome: 'error' });
      // Permanent trust-gate rejections can never succeed on replay — ack them instead of poisoning the shared
      // inbox into a retry loop. SealOpen/SealKeyUnknown stay retryable (key can recover) via the rethrow below.
      const isPermanent =
        reason === 'plaintext_after_activation' || reason === 'zone_correlation' || reason === 'malformed_plaintext';
      if (!isPermanent) throw error;
      return;
    }
    this.logger.log(`Processing result: name=${resolved.name} id=${resolved.id}`);
    let softFailed = false;
    try {
      softFailed = (await this.dispatchResult(resolved)) === HANDLER_SOFT_FAIL;
    } catch (error) {
      this.resultsProcessed.add(1, { kind: resolved.name, outcome: 'error' });
      throw error;
    }
    this.resultsProcessed.add(1, { kind: resolved.name, outcome: softFailed ? 'error' : 'ok' });
  }

  private async dispatchResult(resolved: ProcessableJob) {
    if (!isResultJobName(resolved.name)) {
      this.logger.warn(`Unknown result job type: ${resolved.name}`);
      return;
    }
    switch (resolved.name) {
      case RESULT_JOB_NAME.JOB_RESULT:
        return this.handleStepResult(resolved);
      case RESULT_JOB_NAME.JOB_COMPLETED:
        return this.handleJobCompleted(resolved);
      case RESULT_JOB_NAME.DISCOVERY_COMPLETE:
        return this.handleDiscoveryComplete(resolved);
      case RESULT_JOB_NAME.DEVICE_HEALTH:
        return this.handleDeviceHealth(resolved);
      case RESULT_JOB_NAME.DEVICE_PHONE_HOME:
        return this.handleBrokkrLivePhoneHome(resolved);
      case RESULT_JOB_NAME.RENDER_REQUEST:
        return this.handleRenderRequest(resolved);
      case RESULT_JOB_NAME.SECRET_REVEALED:
        return this.handleSecretRevealed(resolved);
      default: {
        const exhaustive: never = resolved.name;
        this.logger.warn(`Unknown result job type: ${String(exhaustive)}`);
      }
    }
  }

  private async resolveInboundData(job: ProcessableJob): Promise<ProcessableJob> {
    if (isSealedEnvelope(job.data)) {
      const { plaintext, zoneId: senderZoneId } = await this.sealedEnvelope.openBridgeToHub(job.data, {
        queueName: RESULTS_QUEUE_NAME,
      });
      const opened: unknown = JSON.parse(plaintext.toString('utf8'));
      // Tenant isolation (C11 companion): a body carrying a zone MUST name the authenticated sender, else an enrolled zone could drive another zone's devices; zoneless bodies are left to their handler.
      const bodyZone = zonePrefixOf(opened);
      if (bodyZone !== undefined && bodyZone !== senderZoneId) {
        this.logger.error(
          `zone-crypto: sealed bridge→hub body zone mismatch (authenticated sender=${senderZoneId}, body=${bodyZone}) job=${job.name}; rejecting`,
        );
        throw new ZoneCorrelationError(
          `body_zone_mismatch: sender=${senderZoneId}, body=${bodyZone}, name=${job.name}`,
        );
      }
      this.logger.log(
        `zone-crypto: opened sealed bridge→hub result (encrypted creds received) zone=${senderZoneId} job=${job.name}`,
      );
      return { id: job.id, name: job.name, data: opened };
    }

    // Plaintext results MUST carry their zone; fail CLOSED on a missing one — a forger could omit it to dodge the activation gate.
    const zoneId = zonePrefixOf(job.data);
    if (zoneId === undefined) {
      this.logger.error(`zone-crypto: PLAINTEXT bridge→hub result rejected (missing_zone) job=${job.name}`);
      throw new PlaintextAfterActivationError(`missing_zone: name=${job.name}`);
    }
    if (await this.sealedEnvelope.isZoneEnrolled(zoneId)) {
      this.logger.error(
        `zone-crypto: PLAINTEXT bridge→hub result rejected (plaintext_after_activation) zone=${zoneId} job=${job.name}`,
      );
      throw new PlaintextAfterActivationError(`plaintext_after_activation: zone=${zoneId}, name=${job.name}`);
    }

    return job;
  }

  private async handleRenderRequest(job: ProcessableJob) {
    const parsed = renderRequestSchema.safeParse(job.data);
    if (!parsed.success) {
      this.logger.error(`render.request: invalid payload (id=${job.id}): ${parsed.error.message}`);
      return;
    }
    const req = parsed.data;
    try {
      await this.renderRequestDispatcher.dispatch(req);
      this.logger.log(`render.request handled: domain=${req.domain} request=${req.request_id}`);
    } catch (error) {
      if (
        error instanceof NotImplementedException ||
        error instanceof BadRequestException ||
        error instanceof NotFoundException
      ) {
        this.logger.warn(
          `render.request unfulfillable (${error.constructor.name}): ${getErrorMessage(error)}`,
          req.request_id,
        );
        return;
      }
      this.logger.error(
        `render.request failed: ${getErrorMessage(error)} (request=${req.request_id})`,
        undefined,
        req.request_id,
      );
      throw error;
    }
  }

  private async handleSecretRevealed(job: ProcessableJob) {
    const parsed = secretRevealedSchema.safeParse(job.data);
    if (!parsed.success) {
      this.logger.error(`secret.revealed: invalid payload (id=${job.id}): ${parsed.error.message}`);
      return;
    }
    const { request_id, device_id, secret } = parsed.data;
    // Encrypted at rest with a hub-process-only key (AAD-bound to requestId) so a Redis-read attacker can't read the stash.
    const hubPriv = this.zoneCryptoConfig.privateKey;
    if (hubPriv === null) {
      this.logger.error(`Cannot stash reveal for ${request_id}: hub crypto dormant; dropping`);
      return;
    }
    const blob = encryptStash(
      deriveStashKey(hubPriv),
      Buffer.from(JSON.stringify(secret), 'utf8'),
      revealStashAad(device_id, request_id),
    );
    await this.redis.set(revealStashKey(device_id, request_id), blob, 'EX', REVEAL_STASH_TTL_SECONDS);
    this.logger.log(`Secret reveal stashed (encrypted) for request ${request_id} (device ${device_id})`);

    // REVEAL_DELIVERED audit: purpose/kind/version recovered from the correlated REVEAL_REQUESTED row. The stash is
    // already durably written above, so audit bookkeeping must fail soft — an audit hiccup here can never drop the reply.
    try {
      const device = await this.prisma.device.findUnique({ where: { id: device_id }, select: { zoneId: true } });
      const requested = await this.prisma.deviceSecretAuditEvent.findFirst({
        where: { deviceId: device_id, requestId: request_id, event: DeviceSecretAuditEventType.REVEAL_REQUESTED },
        orderBy: { createdAt: 'desc' },
        select: { purpose: true, kind: true, version: true },
      });
      await this.deviceSecretAudit.record({
        deviceId: device_id,
        event: DeviceSecretAuditEventType.REVEAL_DELIVERED,
        purpose: requested?.purpose ?? null,
        kind: requested?.kind ?? null,
        version: requested?.version ?? null,
        requestId: request_id,
        actor: { type: DeviceSecretActorType.BRIDGE, id: device?.zoneId ?? null },
        ...(requested ? {} : { payload: { correlationMissing: true } }),
      });
    } catch (error) {
      this.logger.error(
        `Failed to record REVEAL_DELIVERED for request ${request_id} (device ${device_id}): ${getErrorMessage(error)}`,
        undefined,
        request_id,
      );
    }
  }

  private async handleDiscoveryComplete(job: ProcessableJob) {
    const data = discoveryCompleteDataSchema.parse(job.data);

    this.logger.log(
      `Discovery complete: zone=${data.zone_prefix} device=${data.device_id} fields=${data.fields.length}`,
    );

    await this.discoveryIngress.handleDiscoveryComplete(data);
  }

  private async handleStepResult(job: ProcessableJob) {
    const data = jobResultDataSchema.parse(job.data);

    this.logger.log(
      `Step result: zone=${data.zone_prefix} job=${data.plan_id} step=${data.step_name} status=${data.status} event=${data.event_type}`,
      data.plan_id,
    );

    if (data.event_type === 'job_blocked') return;

    // C11 must gate the engine (it trusts validated input); applyStepResult returns false when no LifecycleJob exists, so the mutations below still run.
    let engineHandled = false;
    if (LIFECYCLE_ENGINE_SAGAS.has(data.action_type)) {
      const gate = await this.assertPlanMatchesDevice(data.plan_id, data.device_id);
      if (gate !== 'proceed') return gate === 'reject' ? HANDLER_SOFT_FAIL : undefined;
      engineHandled = await this.lifecycleInbound.applyStepResult(data);
    }

    if (data.event_type === 'job_failed') {
      this.logger.error(
        `Step failed: zone=${data.zone_prefix} job=${data.plan_id} saga=${data.action_type} step=${data.step_name} device=${data.device_id} status=${data.status} error=${data.error?.message ?? 'unknown'}`,
        undefined,
        data.plan_id,
      );

      if (data.action_type === 'network_scan') {
        await this.networkScanService.storeScanResult(
          data.plan_id,
          'failed',
          undefined,
          data.error?.message ?? 'Scan step failed',
        );
        return;
      }

      const lifecycleSagas = ['provision', 'deprovision', 'commission'];
      if (lifecycleSagas.includes(data.action_type)) {
        const gate = await this.assertPlanMatchesDevice(data.plan_id, data.device_id);
        if (gate !== 'proceed') return gate === 'reject' ? HANDLER_SOFT_FAIL : undefined;
        // Skip when the engine owns this job — it already set the FAILED status.
        if (!engineHandled) {
          this.logger.warn(
            `Marking device ${data.device_id} as failed due to ${data.action_type} step '${data.step_name}' failure`,
            data.plan_id,
          );
          await this.updateServerLifecycle(data.device_id, 'failed', data.plan_id, 'saga_result');
        }
      } else {
        this.logger.log(
          `Step failure for non-lifecycle saga '${data.action_type}' — device status unchanged`,
          data.plan_id,
        );
      }
    }

    if (data.action_type === 'network_scan' && data.status === 'complete' && data.result) {
      await this.networkScanService.storeScanResult(data.plan_id, 'complete', data.result ?? undefined);
    }

    const powerControlSagas = ['reboot', 'power_on', 'power_off', 'deprovision', 'commission', 'provision'];
    if (powerControlSagas.includes(data.action_type) && data.event_type === 'stage_changed') {
      const powerStatus = this.mapPowerStepToStatus(data.step_name, data.status);
      if (powerStatus) {
        const gate = await this.assertPlanMatchesDevice(data.plan_id, data.device_id);
        if (gate !== 'proceed') return gate === 'reject' ? HANDLER_SOFT_FAIL : undefined;
        await this.updateDevicePowerStatus(data.device_id, powerStatus, data.plan_id);
      }
    }

    if (data.action_type === 'benchmarks' && data.event_type === 'stage_changed' && data.result) {
      await this.handleBenchmarkResult(data);
    }

    // Persist wipe sanitization reports on success AND failure — the failed NIST 800-88 report is the most compliance-critical one and must not be dropped.
    const wipeReportTerminal = data.status === 'complete' || data.event_type === 'job_failed';
    if (
      (WIPE_STEP_NAMES as readonly string[]).includes(data.step_name) &&
      wipeReportTerminal &&
      data.device_id &&
      data.action_type &&
      data.result?.sanitization_report
    ) {
      // Correlate the plan to the device before persisting so a misrouted message can't
      // attribute a wipe report to the wrong device (parity with the other handlers here).
      const gate = await this.assertPlanMatchesDevice(data.plan_id, data.device_id);
      if (gate === 'reject') return HANDLER_SOFT_FAIL;
      if (gate === 'proceed') {
        const parsed = sanitizationReportSchema.safeParse(data.result.sanitization_report);
        if (parsed.success) {
          // Isolated: an unpersistable report must not abort sibling step-result work or poison the message into a retry loop.
          try {
            await this.sanitizationReportService.createFromStepResult(
              data.device_id,
              data.action_type,
              parsed.data,
              data.plan_id,
            );
          } catch (error) {
            this.logger.error(
              `Failed to persist sanitization report for device ${data.device_id}: ${getErrorMessage(error)}`,
              undefined,
              data.plan_id,
            );
          }
        } else {
          this.logger.warn(
            `Invalid sanitization report from device ${data.device_id}: ${parsed.error.message}`,
            data.plan_id,
          );
        }
      }
    }

    if (
      data.action_type === 'provision' &&
      data.event_type === 'stage_changed' &&
      data.step_name === 'deploy_os' &&
      data.status === 'complete'
    ) {
      const gate = await this.assertPlanMatchesDevice(data.plan_id, data.device_id);
      if (gate !== 'proceed') return gate === 'reject' ? HANDLER_SOFT_FAIL : undefined;
      // OS is now on disk → release the brokkr-discovery boot override so the post-deploy reboot boots
      // installed_os off disk instead of looping back into Brokkr Live, then republish (rescue_os=null).
      await this.clearDeploymentRescueOs(data.device_id);
      await this.republishDeviceRecord(data.device_id, data.plan_id, 'deploy_os complete');
    }
  }

  private async handleJobCompleted(job: ProcessableJob) {
    const data = jobCompletedDataSchema.parse(job.data);
    // Count after handling settles: a transient failure rethrows for a BullMQ retry (avoid double-count
    // per attempt), and a trust-gate refusal soft-fails without recording — it was never a real completion.
    const result = await this.applyJobCompleted(data);
    if (result === HANDLER_SOFT_FAIL) return result;
    this.sagasCompleted.add(1, { saga_name: data.saga_name, status: data.status });
    if (typeof data.duration_seconds === 'number') {
      this.sagaDurationSeconds.record(data.duration_seconds, { saga_name: data.saga_name, status: data.status });
    }
  }

  private async applyJobCompleted(data: JobCompletedData) {
    this.logger.log(
      `Job completed: zone=${data.zone_prefix} job=${data.plan_id} saga=${data.saga_name} status=${data.status}`,
      data.plan_id,
    );

    if (data.saga_name === 'network_scan') {
      if (data.status === 'complete') {
        this.logger.log(`Network scan saga complete: planId=${data.plan_id}`, data.plan_id);
      } else {
        await this.networkScanService.storeScanResult(
          data.plan_id,
          'failed',
          undefined,
          data.error?.message ?? 'Network scan saga failed',
        );
      }
      return;
    }

    const device = await this.prisma.device.findUnique({
      where: { id: data.device_id, deletedAt: null },
      select: { id: true },
    });
    if (!device) {
      this.logger.warn(
        `No live Device matches id ${data.device_id} for ${data.saga_name} saga (plan=${data.plan_id}); dropping job.completed`,
        data.plan_id,
      );
      return;
    }

    // C11: reject messages whose plan_id is bound to a different device (spoofed device_id).
    const gate = await this.assertPlanMatchesDevice(data.plan_id, data.device_id);
    if (gate !== 'proceed') return gate === 'reject' ? HANDLER_SOFT_FAIL : undefined;

    const engineHandled = LIFECYCLE_ENGINE_SAGAS.has(data.saga_name)
      ? await this.lifecycleInbound.applyJobCompleted(data)
      : false;

    switch (data.saga_name) {
      case 'provision':
        if (data.status === 'complete') {
          await this.reconcileTeeEnabled(data.device_id, data.plan_id);
          if (await this.qualifyOrchestration.isQualifyDevice(device.id)) {
            await this.qualifyOrchestration.setPhoneHomeRunning(device.id, data.plan_id);
          }
          this.logger.log(`Provision saga complete for device ${data.device_id} — awaiting phone-home`, data.plan_id);
        } else {
          if (!engineHandled)
            await this.updateServerLifecycle(data.device_id, 'failed', data.plan_id, 'saga_completed');
          await this.qualifyOrchestration.handleQualifyFailure(device.id, 'Provision saga failed');
        }
        break;

      case 'deprovision':
        if (data.status === 'complete') {
          await this.revokeBrokkrLiveAfterDeprovision(data.device_id, data.plan_id);
          if (await this.qualifyOrchestration.isQualifyDevice(device.id)) {
            await this.qualifyOrchestration.handleQualifyDeprovisionComplete(device.id, data.plan_id);
          } else if (!engineHandled) {
            await this.updateServerLifecycle(data.device_id, 'inventory', data.plan_id, 'saga_completed');
          }
        } else {
          await this.revokeBrokkrLiveAfterDeprovision(data.device_id, data.plan_id);
          if (!engineHandled)
            await this.updateServerLifecycle(data.device_id, 'failed', data.plan_id, 'saga_completed');
          await this.qualifyOrchestration.handleQualifyFailure(device.id, 'Deprovision saga failed');
        }
        break;

      case 'commission':
        if (data.status === 'complete') {
          this.logger.log(
            `Commission saga complete for device ${data.device_id} — discovery will trigger qualify`,
            data.plan_id,
          );
        } else {
          // Skip when qualify has already advanced this device; conditional updateMany avoids the read-then-write TOCTOU.
          const ADVANCED_STATUSES: ServerLifecycleStatus[] = [
            ServerLifecycleStatus.PROVISIONING,
            ServerLifecycleStatus.PROVISIONED,
            ServerLifecycleStatus.INVENTORY,
            ServerLifecycleStatus.DEPROVISIONING,
            ServerLifecycleStatus.FAILED,
          ];
          const { count } = await this.prisma.server.updateMany({
            where: {
              deviceId: device.id,
              lifecycleStatus: { notIn: ADVANCED_STATUSES },
            },
            data: { lifecycleStatus: ServerLifecycleStatus.FAILED },
          });
          if (count === 0) {
            const server = await this.prisma.server.findUnique({
              where: { deviceId: device.id },
              select: { lifecycleStatus: true },
            });
            if (server) {
              this.logger.log(
                `Ignoring superseded commission failure for device ${data.device_id}: server already ` +
                  `${server.lifecycleStatus} (already failed, or a later retry's qualify has advanced)`,
                data.plan_id,
              );
            } else {
              await this.updateServerLifecycle(data.device_id, 'failed', data.plan_id, 'saga_completed');
              await this.qualifyOrchestration.handleQualifyFailure(device.id, 'Commission saga failed');
            }
          } else {
            // count === 1 (deviceId is unique): a genuine transition into FAILED.
            this.lifecycleTransitions.add(1, {
              to_status: ServerLifecycleStatus.FAILED,
              source: 'saga_completed',
            });
            await this.prisma.device.update({
              where: { id: device.id, deletedAt: null },
              data: { lastJobId: data.plan_id },
            });
            await this.qualifyOrchestration.handleQualifyFailure(device.id, 'Commission saga failed');
          }
        }
        break;

      case 'reboot':
        if (data.status === 'complete') {
          this.logger.log(`Reboot saga complete for device ${data.device_id}`, data.plan_id);
        } else if (!engineHandled) {
          await this.clearDevicePowerStatus(data.device_id, data.plan_id);
        }
        break;

      case 'power_on':
        if (data.status === 'complete') {
          this.logger.log(`Power on saga complete for device ${data.device_id}`, data.plan_id);
        } else if (!engineHandled) {
          await this.clearDevicePowerStatus(data.device_id, data.plan_id);
        }
        break;

      case 'power_off':
        if (data.status === 'complete') {
          if (!engineHandled) await this.updateDevicePowerStatus(data.device_id, 'Powered Off', data.plan_id);
        } else if (!engineHandled) {
          await this.clearDevicePowerStatus(data.device_id, data.plan_id);
        }
        break;

      case 'power_status':
        if (data.status === 'complete') {
          this.logger.log(`Power status check complete for device ${data.device_id}`, data.plan_id);
        } else {
          this.logger.warn(`Power status check failed for device ${data.device_id}`, data.plan_id);
        }
        break;
    }
  }

  private async clearDeploymentRescueOs(deviceId: string): Promise<void> {
    const deployment = await this.prisma.deployment.findFirst({
      where: { server: { deviceId }, endDate: null },
      orderBy: { startDate: 'desc' },
      select: { id: true },
    });
    if (deployment) {
      await this.prisma.deployment.update({
        where: { id: deployment.id },
        data: { rescueLayerId: null },
      });
    }
  }

  private async republishDeviceRecord(deviceId: string, planId: string, opLabel: string): Promise<void> {
    try {
      const result = await this.deviceRecordPublisher.writeForDevice(deviceId, { requestId: planId });
      DeviceRecordPublisher.warnIfPublishSkipped(this.logger, result, opLabel, deviceId, planId);
    } catch (error) {
      this.logger.warn(
        `Failed to republish device_record for ${opLabel} of ${deviceId}: ${getErrorMessage(error)}`,
        planId,
      );
    }
  }

  private async handleDeviceHealth(job: ProcessableJob) {
    const data = deviceHealthDataSchema.parse(job.data);

    try {
      const device = await this.prisma.device.findUnique({
        where: { id: data.device_id, deletedAt: null },
        select: { id: true },
      });

      if (!device) {
        this.logger.warn(`Device health result for unknown device ${data.device_id}`, data.job_id);
        return;
      }

      // Device health results carry job_id (the saga plan_id); if a hub-side Job row exists it must
      // point at the same device. Health checks may fire autonomously without a Job, so a missing row is allowed.
      const gate = await this.assertPlanMatchesDevice(data.job_id, data.device_id);
      if (gate !== 'proceed') return gate === 'reject' ? HANDLER_SOFT_FAIL : undefined;

      await this.prisma.deviceHealthCheck.create({
        data: {
          deviceId: device.id,
          primaryReachable: data.primary_reachable ?? null,
          bmcIcmpReachable: data.bmc_icmp_reachable ?? null,
          bmcIpmiReachable: data.bmc_ipmi_reachable ?? null,
          bmcRedfishReachable: data.bmc_redfish_reachable ?? null,
          bmcCredsValid: data.bmc_creds_valid ?? null,
          poweredOn: data.powered_on ?? null,
          brokkrLiveRunning: data.brokkr_live_running ?? null,
        },
      });

      if (data.powered_on != null) {
        const powerStatus = data.powered_on ? ServerPowerStatus.On : ServerPowerStatus.Off;
        // only writer of powerStatus for a device that never runs a power op; skip no-op writes, and
        // spell NULL out since `not` alone drops NULL rows and a Server row is born NULL.
        await this.prisma.server.updateMany({
          where: {
            deviceId: device.id,
            device: { deletedAt: null },
            OR: [{ powerStatus: { not: powerStatus } }, { powerStatus: null }],
          },
          data: { powerStatus },
        });
      }
    } catch (error) {
      this.logger.error(
        `Failed to store device health for ${data.device_id}: ${getErrorMessage(error)}`,
        undefined,
        data.job_id,
      );
      return HANDLER_SOFT_FAIL;
    }

    this.logger.log(
      `Device health stored: device=${data.device_id} powered=${data.powered_on} bmc_creds=${data.bmc_creds_valid}`,
      data.job_id,
    );
  }

  // Clears any transitional power state a saga left (else the next power command is rejected); never touch lifecycleStatus — only the deployed-OS HTTP phone-home may drive a device to "provisioned".
  private async handleBrokkrLivePhoneHome(job: ProcessableJob) {
    const data = phoneHomeDataSchema.parse(job.data);

    const device = await this.prisma.device.findUnique({
      where: { id: data.device_id, deletedAt: null },
      select: { id: true, zoneId: true },
    });
    if (!device) {
      this.logger.warn(`Brokkr Live phone-home for unknown device ${data.device_id} (boot_id=${data.boot_id})`);
      return;
    }

    if (device.zoneId !== data.zone_prefix) {
      this.resultsRejected.add(1, { reason: 'device_zone_mismatch' });
      this.logger.error(
        `Brokkr Live phone-home zone mismatch: device ${data.device_id} is in zone ${device.zoneId}, ` +
          `but message zone is ${data.zone_prefix}; refusing power-status mutation`,
      );
      return HANDLER_SOFT_FAIL;
    }

    this.logger.log(`Brokkr Live phone-home: device=${data.device_id} boot_id=${data.boot_id}`);
    await this.updateDevicePowerStatus(data.device_id, 'Running', data.boot_id);
  }

  private async handleBenchmarkResult(data: JobResultData) {
    const parsed = benchmarkStepResultSchema.safeParse(data.result);
    if (!parsed.success) {
      this.logger.warn(`Invalid benchmark result: plan=${data.plan_id}`, data.plan_id);
      return;
    }

    const expectedDeviceId = data.device_id;
    if (!expectedDeviceId) {
      this.logger.warn(`Invalid device_id for benchmark result: plan=${data.plan_id}`, data.plan_id);
      return;
    }

    const { test_run_id, test_passed, data: testData } = parsed.data;

    try {
      await this.deviceTestRunsService.update(
        test_run_id,
        {
          status: 'Completed',
          testPassed: test_passed,
          data: testData,
        },
        expectedDeviceId,
      );
      this.logger.log(`Benchmark result stored: testRun=${test_run_id} passed=${test_passed}`, data.plan_id);
    } catch (error) {
      this.logger.error(
        `Failed to store benchmark result for testRun=${test_run_id}: ${getErrorMessage(error)}`,
        undefined,
        data.plan_id,
      );
    }
  }

  // C11: a device-bound Job row's deviceId MUST equal the message's device_id — else a bridge could mutate another tenant's device; no Job row → allow (autonomous health checks / legacy flows) but log.
  private async assertPlanMatchesDevice(planId: string, deviceIdRaw: string): Promise<PlanDeviceGate> {
    if (!deviceIdRaw) {
      this.logger.warn(`Skipping bridge result: missing device_id`, planId);
      return 'skip';
    }

    let jobRecord: { deviceId: string | null } | null;
    try {
      jobRecord = await this.prisma.job.findUnique({
        where: { id: planId },
        select: { deviceId: true },
      });
    } catch (error) {
      this.logger.error(
        `Failed to look up Job for plan ${planId}: ${getErrorMessage(error)}; skipping mutation`,
        undefined,
        planId,
      );
      return 'skip';
    }

    if (!jobRecord) {
      this.logger.warn(`No Job row for plan ${planId}; allowing without correlation check`, planId);
      return 'proceed';
    }

    if (jobRecord.deviceId === null) {
      // Job exists but isn't device-bound (e.g. zone-level scans). Allow.
      return 'proceed';
    }

    if (jobRecord.deviceId !== deviceIdRaw) {
      this.resultsRejected.add(1, { reason: 'plan_device_mismatch' });
      this.logger.error(
        `Bridge result correlation mismatch: plan ${planId} is bound to device id=${jobRecord.deviceId}, ` +
          `but message claims device_id=${deviceIdRaw}; refusing mutation`,
        undefined,
        planId,
      );
      return 'reject';
    }

    return 'proceed';
  }

  private mapPowerStepToStatus(stepName: string, status: string): string | null {
    if (stepName === 'power_off' && status === 'running') return 'Shutting Down';
    if (stepName === 'verify_power_off' && status === 'complete') return 'Powered Off';
    if (stepName === 'power_on' && status === 'running') return 'Starting';
    return null;
  }

  private async writeServerPowerStatus(
    deviceId: string,
    powerStatus: ServerPowerStatus | null,
    jobId: string,
    action: string,
  ) {
    try {
      // UPDATE-only: power telemetry must never CREATE the Server row — it would be born at the INVENTORY default, no-oping the qualify claim.
      const { count } = await this.prisma.server.updateMany({
        where: { deviceId, device: { deletedAt: null } },
        data: { powerStatus },
      });
      if (count > 0) this.logger.log(`Device ${deviceId} powerStatus ${action}`, jobId);
    } catch (error) {
      this.logger.error(`Failed to update device ${deviceId} powerStatus: ${getErrorMessage(error)}`, undefined, jobId);
    }
  }

  private async updateDevicePowerStatus(deviceId: string, powerStatus: string, jobId: string) {
    const typed = powerWordToServerPowerStatus(powerStatus);
    if (!typed) {
      this.logger.warn(`Unmappable power status '${powerStatus}' for device ${deviceId}; skipping`, jobId);
      return;
    }
    await this.writeServerPowerStatus(deviceId, typed, jobId, `updated to ${powerStatus}`);
  }

  private async clearDevicePowerStatus(deviceId: string, jobId: string) {
    await this.writeServerPowerStatus(deviceId, null, jobId, 'cleared (power saga failed)');
  }

  private async reconcileTeeEnabled(deviceId: string, planId: string): Promise<void> {
    try {
      const teeRequested = await this.resolveTeeRequestedFromJob(planId);
      if (teeRequested === null) {
        this.logger.warn(
          `Cannot reconcile teeEnabled for device ${deviceId}: no job payload found for plan ${planId}`,
          planId,
        );
        return;
      }
      const { count } = await this.prisma.server.updateMany({
        where: { deviceId, device: { deletedAt: null } },
        data: { teeEnabled: teeRequested },
      });
      if (count > 0) {
        this.logger.log(`Device ${deviceId} teeEnabled reconciled to ${teeRequested}`, planId);
      }
    } catch (error) {
      this.logger.error(
        `Failed to reconcile teeEnabled for device ${deviceId}: ${getErrorMessage(error)}`,
        undefined,
        planId,
      );
    }
  }

  private async resolveTeeRequestedFromJob(planId: string): Promise<boolean | null> {
    const lifecycleJob = await this.prisma.lifecycleJob.findUnique({
      where: { id: planId },
      select: { payload: true },
    });
    if (lifecycleJob) {
      return this.extractTeeFromPayload(lifecycleJob.payload);
    }
    const legacyJob = await this.prisma.job.findUnique({
      where: { id: planId },
      select: { job: true },
    });
    if (legacyJob) {
      return this.extractTeeFromPayload(legacyJob.job);
    }
    return null;
  }

  private extractTeeFromPayload(payload: unknown): boolean {
    if (!isRecord(payload)) return false;
    const request = payload.request;
    const osSlug = typeof payload.operatingSystemSlug === 'string' ? payload.operatingSystemSlug : '';
    if (!isRecord(request)) {
      const customizations = Array.isArray(payload.customizations)
        ? payload.customizations.filter((c): c is string => typeof c === 'string')
        : null;
      return isTeeRequested(payload.tee === true, osSlug, customizations);
    }
    const customizations = Array.isArray(request.customizations)
      ? request.customizations.filter((c): c is string => typeof c === 'string')
      : null;
    return isTeeRequested(
      request.tee === true,
      typeof request.operatingSystemSlug === 'string' ? request.operatingSystemSlug : osSlug,
      customizations,
    );
  }

  private async revokeBrokkrLiveAfterDeprovision(deviceId: string, planId: string): Promise<void> {
    try {
      await this.deviceTokensService.revokeBrokkrLiveTokensForDevice(
        deviceId,
        DeviceTokenRevocationReason.DEPLOYMENT_ENDED,
        `Deprovision saga completed for device ${deviceId} (plan ${planId})`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to revoke Brokkr Live tokens after deprovision for device ${deviceId}: ${getErrorMessage(error)}`,
        undefined,
        planId,
      );
    }
  }

  private async updateServerLifecycle(
    deviceId: string,
    status: string,
    jobId: string,
    source: 'saga_result' | 'saga_completed',
  ) {
    try {
      if (await this.isSupersededLifecycleWrite(deviceId, jobId)) {
        this.logger.warn(
          `Skipping stale lifecycle write '${status}' for device ${deviceId}: plan ${jobId} predates the device's ` +
            `last applied lifecycle job (replayed/out-of-order bridge result)`,
          jobId,
        );
        return;
      }
      const lifecycleStatus = statusSlugToServerLifecycle(status);
      // Read-only liveness gate (same soft-delete rule as writeServerPowerStatus); deliberately no writes yet —
      // lastJobId must not advance ahead of the status write, or a failure below would drop the retried write.
      const device = await this.prisma.device.findUnique({
        where: { id: deviceId, deletedAt: null },
        select: { id: true },
      });
      if (!device) {
        this.logger.warn(`Skipping lifecycle write '${status}' for missing or soft-deleted device ${deviceId}`, jobId);
        return;
      }
      // Atomic transition detection: unique deviceId lets one createMany win (no double-counted first write) and
      // the conditional updateMany counts 1 only on a real flip; the counter fires right after so no later write strands it.
      const { count: created } = await this.prisma.server.createMany({
        data: [{ deviceId, lifecycleStatus }],
        skipDuplicates: true,
      });
      let transitioned = created === 1;
      if (!transitioned) {
        const { count } = await this.prisma.server.updateMany({
          where: { deviceId, device: { deletedAt: null }, lifecycleStatus: { not: lifecycleStatus } },
          data: { lifecycleStatus },
        });
        transitioned = count === 1;
      }
      if (transitioned) {
        this.lifecycleTransitions.add(1, { to_status: lifecycleStatus, source });
      }
      // lastJobId last: a failure here leaves it stale, which biases the
      // superseded-check toward re-applying — the safe direction.
      await this.prisma.device.update({
        where: { id: deviceId, deletedAt: null },
        data: { lastJobId: jobId },
      });
      this.logger.log(`Device ${deviceId} lifecycle status updated to ${status}`, jobId);
    } catch (error) {
      this.logger.error(
        `Failed to update device ${deviceId} lifecycle status: ${getErrorMessage(error)}`,
        undefined,
        jobId,
      );
    }
  }

  // Replay guard: sealing authenticates the sender but doesn't bound replay (freshness is deliberately advisory — see SealedEnvelopeService.warnIfStale); unestablishable ordering is allowed through so legitimate forward transitions never drop.
  private async isSupersededLifecycleWrite(deviceId: string, incomingJobId: string): Promise<boolean> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { lastJobId: true },
    });
    const lastJobId = device?.lastJobId;
    if (!lastJobId || lastJobId === incomingJobId) return false;

    const [incoming, last] = await Promise.all([this.planCreatedAt(incomingJobId), this.planCreatedAt(lastJobId)]);
    if (incoming === null || last === null) return false;
    return incoming < last;
  }

  private async planCreatedAt(planId: string): Promise<Date | null> {
    const job = await this.prisma.job.findUnique({ where: { id: planId }, select: { createdAt: true } });
    if (job) return job.createdAt;
    const lifecycleJob = await this.prisma.lifecycleJob.findUnique({
      where: { id: planId },
      select: { createdAt: true },
    });
    return lifecycleJob?.createdAt ?? null;
  }
}

export class PlaintextAfterActivationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlaintextAfterActivationError';
  }
}

export class ZoneCorrelationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZoneCorrelationError';
  }
}

const secretRevealedSchema = z.object({
  request_id: z.string(),
  device_id: z.string(),
  secret: z.record(z.string()),
});

// Trust-gate rejection reason for a resolveInboundData failure, matched on typed error classes (never message
// text). SealOpenError carries its stable reason set; SyntaxError = bad opened JSON; null for transient (non-gate) errors.
function inboundRejectionReason(error: unknown): string | null {
  if (error instanceof PlaintextAfterActivationError) return 'plaintext_after_activation';
  if (error instanceof ZoneCorrelationError) return 'zone_correlation';
  if (error instanceof SealOpenError) return error.reason ?? 'seal_open_failed';
  if (error instanceof SyntaxError) return 'malformed_plaintext';
  return null;
}

// The sending zone UUID. Result bodies carry `zone_prefix`; render.request
// carries `zone_id`. Both equal the zone UUID (= BullMQ prefix).
function zonePrefixOf(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value.zone_prefix ?? value.zone_id;
  return typeof candidate === 'string' ? candidate : undefined;
}
