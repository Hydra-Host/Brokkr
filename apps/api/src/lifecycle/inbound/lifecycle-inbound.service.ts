import { PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable } from '@nestjs/common';
import {
  DeviceTokenRevocationReason,
  JobType,
  LifecycleJobPhase,
  Prisma,
  ServerLifecycleStatus,
  ServerPowerStatus,
} from '@repo/database';
import {
  LIFECYCLE_WATCHDOG_QUEUE,
  LifecycleJobRecord,
  PHONE_HOME_EVENT_TYPE,
  PHONE_HOME_OPERATION,
  PHONE_HOME_WATCHDOG_JOB,
  POWER_WATCHDOG_EVENT_TYPE,
  POWER_WATCHDOG_OPERATION,
  STUCK_SWEEP_EVENT_TYPE,
  STUCK_SWEEP_OPERATION,
  SYSTEM_JOB_TYPES,
  TERMINAL_PHASES,
  nextPhaseForBridge,
  type ScheduledJobData,
} from '@repo/lifecycle';
import { getTelemetryMeter } from '@repo/telemetry';
import { Queue } from 'bullmq';
import { bridgeTimestampToDate, type JobCompletedData, type JobResultData } from 'src/brokkr-bridge/types/queue.types';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { JOB_EVENT_RECORDED } from 'src/events/events.types';
import { RedisPubSubService } from 'src/events/redis-pubsub.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { ReservationRecord } from 'src/reservations/reservation.record';
import { createDeviceLifecycleTransitionsCounter } from 'src/telemetry/domain-metrics';
import { Logger } from '../../common/decorators/logger.decorator';
import { getErrorMessage } from '../../common/error-utils';
import { LoggerService } from '../../logger/logger.service';
import { LifecycleService } from '../lifecycle.service';

const PHONE_HOME_DEADLINE_MS = 30 * 60 * 1000;

const PROVISION_FAMILY: ReadonlySet<JobType> = new Set([JobType.Provision, JobType.Reprovision]);

const REQUEST_PHASE_STUCK_MS = 15 * 60 * 1000;
const DISPATCHED_STUCK_MS = 30 * 60 * 1000;
const RUNNING_IDLE_STUCK_MS = 2 * 60 * 60 * 1000;
const SCHEDULED_RESUME_GRACE_MS = 30 * 60 * 1000;
const PHONE_HOME_SWEEP_GRACE_MS = 15 * 60 * 1000;
export const STUCK_SWEEP_PAGE_SIZE = 500;

interface StuckVerdict {
  to: typeof LifecycleJobPhase.FAILED | typeof LifecycleJobPhase.ABORTED;
  reason: string;
}

type ServerStatusWrite = { lifecycleStatus?: ServerLifecycleStatus; powerStatus?: ServerPowerStatus | null };

@Injectable()
export class LifecycleInboundService {
  // Counted only when the deadline transition actually applies — a raced
  // no-op claim is not a timeout.
  private readonly watchdogTimeouts = getTelemetryMeter('brokkr-hub').createCounter(
    'brokkr.lifecycle.watchdog_timeouts',
    { description: 'Lifecycle watchdog deadlines that fired and failed a job' },
  );

  // Same instrument the consumer and phone-home use: engine-owned FAILED/
  // INVENTORY writes must land in this series or they go unalerted.
  private readonly lifecycleTransitions = createDeviceLifecycleTransitionsCounter();

  constructor(
    @Inject(PLUGIN_EVENT_BUS) private readonly eventBus: PluginEventBus,
    @InjectQueue(LIFECYCLE_WATCHDOG_QUEUE) private readonly watchdogQueue: Queue<ScheduledJobData>,
    private readonly prisma: PrismaClient,
    private readonly lifecycleService: LifecycleService,
    private readonly deviceTokensService: DeviceTokensService,
    private readonly redisPubSub: RedisPubSubService,
    @Logger(LifecycleInboundService.name) private readonly logger: LoggerService,
  ) {
    // Pre-register at zero: increase()/rate() can't see a series' birth, so the first
    // engine-written FAILED transition post-restart would never fire the saga-failures alert.
    this.lifecycleTransitions.add(0, { to_status: ServerLifecycleStatus.FAILED, source: 'lifecycle_engine' });
  }

  private static readonly STAMP_DRIFT_TOLERANCE_MS = 24 * 60 * 60 * 1000;

  /** A bridge stamp is only ever a moment ago; anything a day out means the unit changed on the
   *  wire again, which is worth a line in the log rather than silent decades-off audit rows. */
  private bridgeStamp(seconds: number, planId: string): Date {
    const at = bridgeTimestampToDate(seconds);
    const drift = Math.abs(Date.now() - at.getTime());
    if (drift > LifecycleInboundService.STAMP_DRIFT_TOLERANCE_MS) {
      this.logger.warn(
        `bridge timestamp ${seconds} for plan ${planId} resolves to ${at.toISOString()}, ${Math.round(drift / 86_400_000)}d from now — check the wire unit`,
      );
    }
    return at;
  }

  async applyStepResult(data: JobResultData): Promise<boolean> {
    if (data.event_type === 'job_blocked') return false;

    const job = await this.loadJob(data.plan_id);
    if (!job) return false;

    await LifecycleJobRecord.appendEvent({
      jobId: job.data.id,
      sagaName: data.action_type,
      stepName: data.step_name,
      operation: data.operation ?? null,
      eventType: data.event_type,
      status: data.status,
      result: this.toJson(data.result),
      error: data.error?.message ?? null,
      attempt: data.attempt,
      occurredAt: this.bridgeStamp(data.timestamp, data.plan_id),
    });

    const next = nextPhaseForBridge(job.data.jobType, job.data.phase, data.event_type, data.status);
    await this.transition(job, next, data.error?.message);
    await this.publishJobEvent(
      job.data.id,
      job.data.deviceId,
      job.data.deploymentId,
      job.data.organizationId,
      job.data.phase,
    );
    return true;
  }

  async applyJobCompleted(data: JobCompletedData): Promise<boolean> {
    const job = await this.loadJob(data.plan_id);
    if (!job) return false;

    await LifecycleJobRecord.appendEvent({
      jobId: job.data.id,
      sagaName: data.saga_name,
      stepName: '(saga)',
      eventType: 'job_completed',
      status: data.status,
      error: data.error?.message ?? null,
      occurredAt: this.bridgeStamp(data.timestamp, data.plan_id),
    });

    const next = nextPhaseForBridge(job.data.jobType, job.data.phase, 'job_completed', data.status);
    const applied = await this.transition(job, next, data.error?.message);
    if (
      !applied &&
      next === LifecycleJobPhase.COMPLETED &&
      job.data.jobType === JobType.Deprovision &&
      job.data.phase !== LifecycleJobPhase.REQUESTED &&
      job.data.phase !== LifecycleJobPhase.ABORTED
    ) {
      await this.ensureDeploymentEnded(job);
    }
    await this.publishJobEvent(
      job.data.id,
      job.data.deviceId,
      job.data.deploymentId,
      job.data.organizationId,
      job.data.phase,
    );
    return true;
  }

  async applyPhoneHome(deviceId: string): Promise<void> {
    const job: LifecycleJobRecord | null = await LifecycleJobRecord.findOneUnscoped({
      where: { deviceId, phase: LifecycleJobPhase.AWAITING_PHONE_HOME },
    });
    if (!job) return;

    await LifecycleJobRecord.appendEvent({
      jobId: job.data.id,
      sagaName: 'phone_home',
      stepName: 'phone_home',
      operation: PHONE_HOME_OPERATION,
      eventType: PHONE_HOME_EVENT_TYPE,
      status: 'complete',
      occurredAt: new Date(),
    });

    if (await this.transition(job, LifecycleJobPhase.COMPLETED)) {
      await this.publishJobEvent(
        job.data.id,
        job.data.deviceId,
        job.data.deploymentId,
        job.data.organizationId,
        LifecycleJobPhase.COMPLETED,
      );
    }
  }

  async checkPhoneHomeDeadline(jobId: string): Promise<void> {
    const job = await this.loadJob(jobId);
    if (!job || job.data.phase !== LifecycleJobPhase.AWAITING_PHONE_HOME) return;

    if (await this.deployedOsAlreadyPhonedHome(job)) {
      this.logger.warn(
        `Phone-home watchdog: device ${job.data.deviceId} is PROVISIONED but job ${jobId} never saw the callback — completing instead of failing`,
      );
      await LifecycleJobRecord.appendEvent({
        jobId: job.data.id,
        sagaName: 'phone_home',
        stepName: 'phone_home',
        operation: PHONE_HOME_OPERATION,
        eventType: PHONE_HOME_EVENT_TYPE,
        status: 'complete',
        occurredAt: new Date(),
      });
      if (await this.transition(job, LifecycleJobPhase.COMPLETED)) {
        await this.publishJobEvent(
          job.data.id,
          job.data.deviceId,
          job.data.deploymentId,
          job.data.organizationId,
          LifecycleJobPhase.COMPLETED,
        );
      }
      return;
    }

    this.logger.warn(`Phone-home deadline exceeded for job ${jobId} (device ${job.data.deviceId}) — failing`);
    await LifecycleJobRecord.appendEvent({
      jobId: job.data.id,
      sagaName: 'phone_home',
      stepName: 'phone_home',
      operation: PHONE_HOME_OPERATION,
      eventType: PHONE_HOME_EVENT_TYPE,
      status: 'failed',
      error: 'phone-home deadline exceeded',
      occurredAt: new Date(),
    });

    if (await this.transition(job, LifecycleJobPhase.FAILED, 'phone-home deadline exceeded')) {
      this.watchdogTimeouts.add(1);
      await this.publishJobEvent(
        job.data.id,
        job.data.deviceId,
        job.data.deploymentId,
        job.data.organizationId,
        LifecycleJobPhase.FAILED,
      );
    }
  }

  private async deployedOsAlreadyPhonedHome(job: LifecycleJobRecord): Promise<boolean> {
    const { deviceId, jobType } = job.data;
    if (!deviceId) return false;
    if (jobType !== JobType.Provision && jobType !== JobType.Reprovision) return false;
    const server = await this.prisma.server.findUnique({
      where: { deviceId },
      select: { lifecycleStatus: true },
    });
    return server?.lifecycleStatus === ServerLifecycleStatus.PROVISIONED;
  }

  async checkPowerSagaDeadline(jobId: string): Promise<void> {
    const job = await this.loadJob(jobId);
    if (!job) return;
    if (job.data.phase !== LifecycleJobPhase.DISPATCHED && job.data.phase !== LifecycleJobPhase.RUNNING) return;

    await LifecycleJobRecord.appendEvent({
      jobId: job.data.id,
      sagaName: 'power_watchdog',
      stepName: 'power_watchdog',
      operation: POWER_WATCHDOG_OPERATION,
      eventType: POWER_WATCHDOG_EVENT_TYPE,
      status: 'failed',
      error: 'power saga deadline exceeded',
      occurredAt: new Date(),
    });

    if (await this.transition(job, LifecycleJobPhase.FAILED, 'power saga deadline exceeded')) {
      this.watchdogTimeouts.add(1);
      await this.publishJobEvent(
        job.data.id,
        job.data.deviceId,
        job.data.deploymentId,
        job.data.organizationId,
        LifecycleJobPhase.FAILED,
      );
    }
  }

  async sweepStuckJobs(): Promise<number> {
    let swept = 0;
    let cursorId: string | undefined;

    for (;;) {
      const page: LifecycleJobRecord[] = await LifecycleJobRecord.findManyUnscoped({
        where: { phase: { notIn: [...TERMINAL_PHASES] } },
        orderBy: { id: 'asc' },
        take: STUCK_SWEEP_PAGE_SIZE,
        ...(cursorId !== undefined ? { skip: 1, cursor: { id: cursorId } } : {}),
      });
      if (page.length === 0) break;
      cursorId = page[page.length - 1].data.id;

      const runningIds = page.filter((job) => job.data.phase === LifecycleJobPhase.RUNNING).map((job) => job.data.id);
      const lastEventByJob = await this.loadLastRunningEventTimes(runningIds);

      for (const job of page) {
        try {
          if (await this.sweepIfStuck(job, lastEventByJob)) swept++;
        } catch (error) {
          this.logger.error(`Stuck sweep failed for job ${job.data.id}: ${getErrorMessage(error)}`);
        }
      }

      if (page.length < STUCK_SWEEP_PAGE_SIZE) break;
    }
    return swept;
  }

  private async loadLastRunningEventTimes(jobIds: string[]): Promise<Map<string, Date>> {
    if (jobIds.length === 0) return new Map();
    const grouped = await this.prisma.lifecycleJobEvent.groupBy({
      by: ['jobId'],
      where: { jobId: { in: jobIds } },
      _max: { recordedAt: true },
    });
    const byJob = new Map<string, Date>();
    for (const row of grouped) {
      if (row._max.recordedAt) byJob.set(row.jobId, row._max.recordedAt);
    }
    return byJob;
  }

  private async sweepIfStuck(job: LifecycleJobRecord, lastEventByJob: Map<string, Date>): Promise<boolean> {
    const verdict = this.stuckVerdict(job, lastEventByJob);
    if (!verdict) return false;

    const from = job.data.phase;
    const claimed = await LifecycleJobRecord.claimTransition(job.data.id, from, verdict.to, verdict.reason);
    if (!claimed) return false;

    if (verdict.to === LifecycleJobPhase.FAILED) job.fail(verdict.reason);
    else job.abort(verdict.reason);

    await LifecycleJobRecord.appendEvent({
      jobId: job.data.id,
      sagaName: 'stuck_sweep',
      stepName: 'stuck_sweep',
      operation: STUCK_SWEEP_OPERATION,
      eventType: STUCK_SWEEP_EVENT_TYPE,
      status: 'failed',
      error: verdict.reason,
      occurredAt: new Date(),
    });
    await this.publishJobEvent(
      job.data.id,
      job.data.deviceId,
      job.data.deploymentId,
      job.data.organizationId,
      verdict.to,
    );

    if (from === LifecycleJobPhase.SCHEDULED && job.data.deploymentId && job.data.organizationId) {
      await DeploymentRecord.clearScheduledInterruption(job.data.deploymentId, job.data.organizationId);
    }

    await this.applySideEffects(job, verdict.to);
    this.emitForPhase(job, verdict.to);
    await this.chainLinkedJob(job, verdict.to);
    this.logger.warn(
      `Stuck sweep: job ${job.data.id} (${job.data.jobType}) ${from} → ${verdict.to}: ${verdict.reason}`,
    );
    return true;
  }

  private stuckVerdict(job: LifecycleJobRecord, lastEventByJob: Map<string, Date>): StuckVerdict | null {
    const now = Date.now();
    const { phase, updatedAt, scheduledAt, phoneHomeDeadline } = job.data;

    switch (phase) {
      case LifecycleJobPhase.REQUESTED:
      case LifecycleJobPhase.AUTHORIZING:
        if (now - updatedAt.getTime() < REQUEST_PHASE_STUCK_MS) return null;
        return { to: LifecycleJobPhase.ABORTED, reason: `stuck in ${phase}: request never dispatched` };

      case LifecycleJobPhase.SCHEDULED: {
        const resumeDue = (scheduledAt ?? updatedAt).getTime() + SCHEDULED_RESUME_GRACE_MS;
        if (now < resumeDue) return null;
        return { to: LifecycleJobPhase.ABORTED, reason: 'grace timer never resumed the job' };
      }

      case LifecycleJobPhase.DISPATCHED:
        if (now - updatedAt.getTime() < DISPATCHED_STUCK_MS) return null;
        return { to: LifecycleJobPhase.FAILED, reason: 'no bridge response after dispatch' };

      case LifecycleJobPhase.RUNNING: {
        if (now - updatedAt.getTime() < RUNNING_IDLE_STUCK_MS) return null;
        const lastEventAt = lastEventByJob.get(job.data.id);
        if (lastEventAt && now - lastEventAt.getTime() < RUNNING_IDLE_STUCK_MS) return null;
        return { to: LifecycleJobPhase.FAILED, reason: 'no bridge activity while running' };
      }

      case LifecycleJobPhase.AWAITING_PHONE_HOME: {
        const deadline = phoneHomeDeadline?.getTime() ?? updatedAt.getTime() + PHONE_HOME_DEADLINE_MS;
        if (now < deadline + PHONE_HOME_SWEEP_GRACE_MS) return null;
        return { to: LifecycleJobPhase.FAILED, reason: 'phone-home deadline exceeded' };
      }

      default:
        return null;
    }
  }

  private async publishJobEvent(
    jobId: string,
    deviceId: string | null,
    deploymentId: string | null,
    organizationId: string | null,
    phase: string | null,
  ): Promise<void> {
    if (deviceId === null) return;
    try {
      const device = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { supplierId: true } });
      await this.redisPubSub.publish({
        type: JOB_EVENT_RECORDED,
        deviceId,
        deploymentId,
        organizationId,
        supplierId: device?.supplierId ?? null,
        jobId,
        phase,
      });
    } catch (error) {
      this.logger.warn(`Failed to publish job event for ${jobId}: ${getErrorMessage(error)}`);
    }
  }

  private async loadJob(planId: string): Promise<LifecycleJobRecord | null> {
    const job: LifecycleJobRecord | null = await LifecycleJobRecord.findByIdUnscoped(planId);
    if (!job) {
      this.logger.debug(`No LifecycleJob for plan_id ${planId}; caller handles it`);
    }
    return job;
  }

  private async transition(
    job: LifecycleJobRecord,
    target: LifecycleJobPhase | null,
    error?: string,
  ): Promise<boolean> {
    if (!target || target === job.data.phase) return false;
    if (TERMINAL_PHASES.has(job.data.phase)) {
      this.logger.warn(`Ignoring ${target} for terminal job ${job.data.id} (${job.data.phase})`);
      return false;
    }

    // A plan_id only exists after the DISPATCHED save — a result for a REQUESTED job signals corruption, not progress.
    if (job.data.phase === LifecycleJobPhase.REQUESTED) {
      this.logger.error(`Ignoring ${target} for job ${job.data.id}: result arrived while still REQUESTED`);
      return false;
    }

    if (target === LifecycleJobPhase.AWAITING_PHONE_HOME && (await this.deployedOsAlreadyPhonedHome(job))) {
      this.logger.warn(
        `Job ${job.data.id}: device ${job.data.deviceId} already PROVISIONED at saga completion — completing without a phone-home wait`,
      );
      await LifecycleJobRecord.appendEvent({
        jobId: job.data.id,
        sagaName: 'phone_home',
        stepName: 'phone_home',
        operation: PHONE_HOME_OPERATION,
        eventType: PHONE_HOME_EVENT_TYPE,
        status: 'complete',
        occurredAt: new Date(),
      });
      target = LifecycleJobPhase.COMPLETED;
    }

    // CAS must guard on the phase as read, before the normalization below mutates it.
    const fromPhase = job.data.phase;

    if (fromPhase === LifecycleJobPhase.AWAITING_PHONE_HOME && TERMINAL_PHASES.has(target)) {
      const failError = target === LifecycleJobPhase.FAILED ? (error ?? 'bridge reported failure') : error;
      const claimed = await LifecycleJobRecord.claimTransition(job.data.id, fromPhase, target, failError);
      if (!claimed) return false;
      if (target === LifecycleJobPhase.COMPLETED) job.complete();
      else job.fail(failError!);

      await this.applySideEffects(job, target);
      this.emitForPhase(job, target);
      await this.chainLinkedJob(job, target);
      return true;
    }

    // Bridge results are facts about work already done, so the job is at least DISPATCHED: SCHEDULED/AUTHORIZING means a resume retry rewound it after a partial dispatch (re-walk forward edges); job.completed can also arrive before any stage_changed.
    if (job.data.phase === LifecycleJobPhase.SCHEDULED) job.authorize();
    if (job.data.phase === LifecycleJobPhase.AUTHORIZING) job.dispatch();

    switch (target) {
      case LifecycleJobPhase.RUNNING:
        job.beginRunning();
        break;
      case LifecycleJobPhase.AWAITING_PHONE_HOME:
        if (job.data.phase === LifecycleJobPhase.DISPATCHED) job.beginRunning();
        job.awaitPhoneHome(new Date(Date.now() + PHONE_HOME_DEADLINE_MS));
        break;
      case LifecycleJobPhase.COMPLETED:
        if (job.data.phase === LifecycleJobPhase.DISPATCHED) job.beginRunning();
        job.complete();
        break;
      case LifecycleJobPhase.FAILED:
        job.fail(error ?? 'bridge reported failure');
        break;
      default:
        return false;
    }
    await job.save();

    await this.applySideEffects(job, target);
    this.emitForPhase(job, target);
    await this.chainLinkedJob(job, target);

    if (target === LifecycleJobPhase.AWAITING_PHONE_HOME) {
      await this.watchdogQueue.add(
        PHONE_HOME_WATCHDOG_JOB,
        { jobId: job.data.id },
        { delay: PHONE_HOME_DEADLINE_MS, jobId: job.data.id },
      );
    }
    return true;
  }

  private async applySideEffects(job: LifecycleJobRecord, phase: LifecycleJobPhase): Promise<void> {
    const deviceId = job.data.deviceId;
    if (!deviceId) return;
    const jobType = job.data.jobType;
    if (SYSTEM_JOB_TYPES.has(jobType)) return;

    if (phase === LifecycleJobPhase.FAILED) {
      const write: ServerStatusWrite =
        jobType === JobType.Reboot || jobType === JobType.PowerOn || jobType === JobType.PowerOff
          ? { powerStatus: null }
          : { lifecycleStatus: ServerLifecycleStatus.FAILED };
      await this.writeServer(deviceId, job.data.id, write);
      if (jobType === JobType.Deprovision && job.data.scheduledAt && job.data.deploymentId && job.data.organizationId) {
        await DeploymentRecord.clearScheduledInterruption(job.data.deploymentId, job.data.organizationId);
      }
      return;
    }

    if (phase === LifecycleJobPhase.COMPLETED) {
      if (jobType === JobType.Deprovision) {
        await this.writeServer(deviceId, job.data.id, { lifecycleStatus: ServerLifecycleStatus.INVENTORY });
        await this.ensureDeploymentEnded(job);
        return;
      }
      if (jobType === JobType.PowerOff) {
        await this.writeServer(deviceId, job.data.id, { powerStatus: ServerPowerStatus.Off });
        return;
      }
    }
  }

  private async ensureDeploymentEnded(job: LifecycleJobRecord): Promise<void> {
    let { deploymentId, organizationId } = job.data;
    // Lifecycle-only wipe jobs carry null deploymentId; still converge if a rental raced in mid-job.
    if (!deploymentId || !organizationId) {
      const raced = await DeploymentRecord.findAggregateUnscoped({
        where: { endDate: null, server: { deviceId: job.data.deviceId } },
      });
      if (!raced) return;
      deploymentId = raced.id;
      organizationId = raced.customerId;
    }
    const record: DeploymentRecord | null = await DeploymentRecord.findOneUnscoped({
      where: { id: deploymentId, customerId: organizationId },
    });
    if (!record) return;
    const wasOpen = !record.data.endDate;
    if (!wasOpen && !record.data.reservationId) return;
    try {
      if (wasOpen) {
        // Match DeprovisionOperation.dispatch: ending an open rental must revoke DEPLOYMENT_OS tokens.
        await this.deviceTokensService.runWithDeploymentTokenRevocation(
          {
            deviceId: job.data.deviceId,
            reason: DeviceTokenRevocationReason.DEPLOYMENT_ENDED,
            note: `Deployment ended by deprovision job ${job.data.id} (completion converge)`,
          },
          async (tx) => {
            record.endDeployment();
            await record.save({ tx });
            if (record.data.reservationId) {
              await ReservationRecord.endActiveByIdUnscoped(record.data.reservationId, tx);
            }
          },
        );
      } else {
        const reservationId = record.data.reservationId;
        if (!reservationId) return;
        await this.prisma.$transaction(async (tx) => {
          await ReservationRecord.endActiveByIdUnscoped(reservationId, tx);
        });
      }
    } catch (error) {
      this.logger.error(
        `Deprovision ${job.data.id}: failed to converge rental end for deployment ${deploymentId}: ${getErrorMessage(error)}`,
      );
      return;
    }
    if (wasOpen) {
      this.logger.warn(`Deprovision ${job.data.id}: deployment ${deploymentId} still active at completion — ended it`);
    }
  }

  private async writeServer(deviceId: string, jobId: string, write: ServerStatusWrite): Promise<void> {
    const newStatus = write.lifecycleStatus;
    // Detect a real transition atomically for the metric: the conditional updateMany
    // matches (count 1) only on an actual change, so a re-write can't double-count.
    let transitioned = false;
    if (newStatus !== undefined) {
      // First-write detection must be atomic: the unique deviceId lets exactly one
      // concurrent creator win createMany; the rest fall to the conditional change check.
      const { count: created } = await this.prisma.server.createMany({
        data: [{ deviceId, ...write, lifecycleStatus: newStatus }],
        skipDuplicates: true,
      });
      transitioned = created === 1;
      if (!transitioned) {
        const { count } = await this.prisma.server.updateMany({
          where: { deviceId, lifecycleStatus: { not: newStatus } },
          data: { lifecycleStatus: newStatus },
        });
        transitioned = count === 1;
      }
      // Count before the auxiliary write: the status already landed, and an upsert
      // failure would otherwise strand the transition forever (retry detects nothing).
      if (transitioned) {
        this.lifecycleTransitions.add(1, { to_status: newStatus, source: 'lifecycle_engine' });
      }
    }
    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastJobId: jobId, server: { upsert: { create: write, update: write } } },
    });
  }

  private async chainLinkedJob(job: LifecycleJobRecord, phase: LifecycleJobPhase): Promise<void> {
    const linkedJobId = job.data.linkedJobId;
    if (!linkedJobId || job.data.jobType !== JobType.Deprovision) return;

    if (phase === LifecycleJobPhase.COMPLETED) {
      await this.lifecycleService.enqueueLinkedProvision(linkedJobId);
      return;
    }
    if (phase === LifecycleJobPhase.FAILED || phase === LifecycleJobPhase.ABORTED) {
      await this.lifecycleService.abortLinkedProvision(
        linkedJobId,
        `outgoing deprovision ${job.data.id} ${phase}: ${job.data.error ?? 'eviction did not complete'}`,
      );
    }
  }

  private emitForPhase(job: LifecycleJobRecord, phase: LifecycleJobPhase): void {
    const jobType = job.data.jobType;
    const outcome = {
      jobId: job.data.id,
      jobType,
      deviceId: job.data.deviceId,
      deploymentId: job.data.deploymentId,
      organizationId: job.data.organizationId,
    };

    if (phase === LifecycleJobPhase.COMPLETED) {
      if (jobType === JobType.Provision) this.eventBus.emit('provision.completed', outcome);
      else if (jobType === JobType.Reprovision) this.eventBus.emit('reprovision.completed', outcome);
      else if (jobType === JobType.Deprovision) {
        this.eventBus.emit('deprovision.completed', outcome);
        if (job.data.scheduledAt && job.data.deploymentId) {
          this.eventBus.emit('deployment.interruption.completed', {
            deploymentId: job.data.deploymentId,
            organizationId: job.data.organizationId,
          });
        }
      }
      return;
    }

    if (phase === LifecycleJobPhase.FAILED && PROVISION_FAMILY.has(jobType)) {
      this.eventBus.emit('provision.failed', { ...outcome, error: job.data.error ?? 'bridge reported failure' });
      return;
    }

    if (phase === LifecycleJobPhase.FAILED && jobType === JobType.Deprovision) {
      this.eventBus.emit('deprovision.failed', { ...outcome, error: job.data.error ?? 'bridge reported failure' });
      return;
    }

    if (phase === LifecycleJobPhase.ABORTED && PROVISION_FAMILY.has(jobType) && job.data.deploymentId) {
      this.eventBus.emit('provision.failed', { ...outcome, error: job.data.error ?? 'lifecycle job aborted' });
    }
  }

  private toJson(value: Record<string, unknown> | null | undefined): Prisma.InputJsonValue | undefined {
    return value == null ? undefined : (value as Prisma.InputJsonValue);
  }
}
