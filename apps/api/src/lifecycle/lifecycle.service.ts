import {
  LifecycleGateDeferral,
  LifecycleGateRejection,
  PLUGIN_EVENT_BUS,
  type PluginEventBus,
} from '@hydrahost/plugin-sdk';
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ActiveRecordRegistry } from '@repo/active-record';
import {
  AdminLifecycleRequestStatus,
  AdminLifecycleRequestType,
  InterruptibleClaimStatus,
  JobType,
  LifecycleJobPhase,
  Prisma,
  RequestSource,
} from '@repo/database';
import { TRANSITIONAL_SERVER_POWER_STATUSES } from '@repo/device-domain';
import {
  DEFAULT_INTERRUPTIBLE_NOTICE_MS,
  FAIL_CLOSED_GATES,
  LIFECYCLE_SCHEDULED_QUEUE,
  LIFECYCLE_WATCHDOG_QUEUE,
  LifecycleJobRecord,
  POWER_WATCHDOG_JOB,
  RESUME_SCHEDULED_JOB,
  START_LINKED_PROVISION_JOB,
  interruptibleEvictionRequiresApproval,
  type ScheduledJobData,
  type SystemJobType,
} from '@repo/lifecycle';
import { Queue } from 'bullmq';
import { Logger } from 'src/common/decorators/logger.decorator';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { LoggerService } from 'src/logger/logger.service';
import { GateUnavailableError, HostPluginGateBus } from 'src/plugin-host/host-plugin-gate-bus';
import { ReservationsService } from 'src/reservations/reservations.service';
import { z } from 'zod';
import { getErrorMessage } from '../common/error-utils';
import { ClusterNetworkService } from './cluster-network.service';
import { DeprovisionOperation } from './operations/deprovision.operation';
import { PowerControlOperation } from './operations/power-control.operation';
import {
  ProvisionOperation,
  ProvisionRequestSchema,
  type ProvisionContext,
  type ProvisionRequest,
} from './operations/provision.operation';
import { RebootOperation } from './operations/reboot.operation';
import { ReprovisionOperation, type ReprovisionRequest } from './operations/reprovision.operation';

export interface RebootRequest {
  deviceId: string;
  deploymentId?: string | null;
  userId: string;
  organizationId: string | null;
  source: RequestSource;
  triggeredByEmail?: string;
}

export interface PowerControlRequest extends RebootRequest {
  operation: 'on' | 'off';
}

export interface DeprovisionRequest {
  deviceId: string;
  userId: string;
  organizationId: string;
  source: RequestSource;
  triggeredByEmail?: string;
  gateOverride?: boolean;
}

export interface InterruptibleDeprovisionRequest extends DeprovisionRequest {
  interruptionWarningTime: number;
}

/** Lifecycle-only deprovision with no active deployment — no organization/billing context applies. */
export interface DeprovisionWithoutDeploymentRequest {
  deviceId: string;
  userId: string;
  source: RequestSource;
  triggeredByEmail?: string;
}

/** Audit extras on the job payload; `retried*` are retry-only. `request.userId` stays the original owner. */
export interface LifecycleJobAudit {
  triggeredByEmail?: string;
  retriedFromJobId?: string;
  retriedBy?: string;
}

export interface InterruptibleProvisionInput {
  request: ProvisionRequest;
  deviceId: string;
  expectedDeploymentId?: string;
}

export interface InterruptibleProvisionResult {
  deprovisionJobId: string;
  incomingJobId: string;
  claimId: string;
}

export type InterruptibleProvisionRequestResult =
  | { status: 'pending_approval'; requestId: string }
  | ({ status: 'executing' } & InterruptibleProvisionResult);

const IncomingProvisionPayloadSchema = z.object({
  interruptible: z.literal(true),
  interruptibleClaimId: z.string(),
  request: ProvisionRequestSchema,
});
type IncomingProvisionPayload = z.infer<typeof IncomingProvisionPayloadSchema>;

const SCHEDULED_RESUME_ATTEMPTS = 5;
const SCHEDULED_RESUME_BACKOFF_MS = 30_000;

const POWER_SAGA_DEADLINE_MS = 15 * 60 * 1000;

const POWER_FAMILY: ReadonlySet<JobType> = new Set([JobType.Reboot, JobType.PowerOn, JobType.PowerOff]);

interface PrepareResult {
  deploymentId?: string | null;
  reservationId?: string | null;
}

interface RunParams {
  jobType: JobType;
  deviceId: string;
  deploymentId?: string | null;
  organizationId: string | null;
  performedBy: string;
  source: RequestSource;
  triggeredByEmail?: string;
  payload: Prisma.JsonObject;
  prepare?: (jobId: string) => Promise<PrepareResult>;
  gate?: (jobId: string, prep: PrepareResult, override: boolean) => Promise<void>;
  gateOverride?: boolean;
  dispatch: (jobId: string, prep: PrepareResult) => Promise<void>;
}

export type SystemJobSource = 'manual' | 'cron' | 'phone-home' | 'discovery';

interface RunSystemParams {
  jobType: SystemJobType;
  deviceId: string;
  zoneId: string;
  source: SystemJobSource;
  dispatch: (jobId: string) => Promise<void>;
}

@Injectable()
export class LifecycleService {
  constructor(
    @Inject(PLUGIN_EVENT_BUS) private readonly eventBus: PluginEventBus,
    private readonly gateBus: HostPluginGateBus,
    @InjectQueue(LIFECYCLE_SCHEDULED_QUEUE) private readonly scheduledQueue: Queue<ScheduledJobData>,
    @InjectQueue(LIFECYCLE_WATCHDOG_QUEUE) private readonly watchdogQueue: Queue<ScheduledJobData>,
    private readonly rebootOperation: RebootOperation,
    private readonly powerControlOperation: PowerControlOperation,
    private readonly deprovisionOperation: DeprovisionOperation,
    private readonly reprovisionOperation: ReprovisionOperation,
    private readonly provisionOperation: ProvisionOperation,
    private readonly reservationsService: ReservationsService,
    private readonly clusterNetwork: ClusterNetworkService,
    @Logger(LifecycleService.name) private readonly logger: LoggerService,
  ) {
    for (const gate of FAIL_CLOSED_GATES) this.gateBus.markFailClosed(gate);
  }

  async requestReboot(input: RebootRequest): Promise<LifecycleJobRecord> {
    return this.run({
      jobType: JobType.Reboot,
      deviceId: input.deviceId,
      deploymentId: input.deploymentId,
      organizationId: input.organizationId,
      performedBy: input.userId,
      source: input.source,
      triggeredByEmail: input.triggeredByEmail,
      payload: {},
      dispatch: (jobId) => this.rebootOperation.dispatch(input.deviceId, jobId),
    });
  }

  async requestPowerControl(input: PowerControlRequest): Promise<LifecycleJobRecord> {
    return this.run({
      jobType: input.operation === 'on' ? JobType.PowerOn : JobType.PowerOff,
      deviceId: input.deviceId,
      deploymentId: input.deploymentId,
      organizationId: input.organizationId,
      performedBy: input.userId,
      source: input.source,
      triggeredByEmail: input.triggeredByEmail,
      payload: { operation: input.operation },
      dispatch: (jobId) => this.powerControlOperation.dispatch(input.deviceId, jobId, input.operation),
    });
  }

  async requestProvision(input: ProvisionRequest): Promise<LifecycleJobRecord> {
    const ctx = await this.provisionOperation.assembleContext(input);
    return this.runProvision(input, ctx);
  }

  // Operator entry (backs PLUGIN_LIFECYCLE_REQUESTS): skips the request-context identity check — the caller is an
  // operator-gated plugin acting for a validated identity. Device/OS/SSH-key validation still runs in full.
  async requestProvisionAsOperator(input: ProvisionRequest, audit?: LifecycleJobAudit): Promise<LifecycleJobRecord> {
    const ctx = await this.provisionOperation.assembleContextForReplay(input);
    return this.runProvision(input, ctx, audit);
  }

  private runProvision(
    input: ProvisionRequest,
    ctx: ProvisionContext,
    audit?: LifecycleJobAudit,
  ): Promise<LifecycleJobRecord> {
    return this.run({
      jobType: JobType.Provision,
      deviceId: input.deviceId,
      organizationId: input.organizationId,
      performedBy: audit?.retriedBy ?? input.userId,
      source: input.source,
      triggeredByEmail: audit?.triggeredByEmail,
      payload: {
        operatingSystemSlug: input.operatingSystemSlug,
        request: this.serializeRequest(input),
        ...this.auditPayload(audit),
      },
      prepare: async () => {
        const reservationId = await this.provisionOperation.createReservation(input);
        try {
          const deploymentId = await this.provisionOperation.createDeployment(input, ctx.baseLayerId, reservationId);
          await this.provisionOperation.acceptInvite(reservationId);
          return { deploymentId, reservationId };
        } catch (error) {
          await this.endReservationQuietly(reservationId);
          throw error;
        }
      },
      gate: (jobId, prep, override) =>
        this.gateBus.runGate(
          'provision.authorize',
          {
            jobId,
            deviceId: input.deviceId,
            deploymentId: prep.deploymentId ?? '',
            organizationId: input.organizationId,
            customerUserId: input.userId,
            internalProvision: input.internalProvision ?? false,
          },
          { override },
        ),
      dispatch: async (jobId, prep) => {
        const deploymentId = this.requireDeploymentId(prep.deploymentId, 'provision dispatch');
        await this.clusterNetwork.attach(deploymentId, input.deviceId);
        try {
          await this.provisionOperation.publish(input, deploymentId, ctx.pubkeys, jobId);
        } catch (error) {
          await this.clusterNetwork.detach(deploymentId, input.deviceId);
          throw error;
        }
      },
    });
  }

  async requestReprovision(input: ReprovisionRequest, audit?: LifecycleJobAudit): Promise<LifecycleJobRecord> {
    const ctx = await this.reprovisionOperation.assembleContext(input);
    return this.run({
      jobType: JobType.Reprovision,
      deviceId: input.deviceId,
      deploymentId: ctx.deploymentId,
      organizationId: ctx.organizationId,
      performedBy: audit?.retriedBy ?? input.userId,
      source: input.source,
      triggeredByEmail: audit?.triggeredByEmail,
      payload: {
        operatingSystemSlug: input.operatingSystemSlug,
        tee: input.tee ?? false,
        customizations: input.customizations ?? null,
        request: this.serializeRequest(input),
        ...this.auditPayload(audit),
      },
      dispatch: (jobId) =>
        this.reprovisionOperation.dispatch({
          input,
          organizationId: ctx.organizationId,
          baseLayerId: ctx.baseLayerId,
          pubkeys: ctx.pubkeys,
          jobId,
        }),
    });
  }

  async requestDeprovision(input: DeprovisionRequest): Promise<LifecycleJobRecord> {
    const { deploymentId } = await this.deprovisionOperation.assembleContext(input.deviceId, input.organizationId);

    return this.run({
      jobType: JobType.Deprovision,
      deviceId: input.deviceId,
      deploymentId,
      organizationId: input.organizationId,
      performedBy: input.userId,
      source: input.source,
      triggeredByEmail: input.triggeredByEmail,
      payload: {},
      gateOverride: input.gateOverride,
      gate: (jobId, _prep, override) =>
        this.runDeprovisionGate(
          jobId,
          input.deviceId,
          deploymentId,
          input.organizationId,
          override,
          override ? input.userId : undefined,
        ),
      dispatch: async (jobId) => {
        await this.clusterNetwork.detach(deploymentId, input.deviceId);
        await this.deprovisionOperation.dispatch({
          deviceId: input.deviceId,
          organizationId: input.organizationId,
          deploymentId,
          jobId,
        });
      },
    });
  }

  /** Get a stuck device unstuck: wipes a device with NO active deployment; rejects if one exists.
   * Skips the billing-shaped deprovision.authorize gate — there's no deployment/org to authorize. */
  async requestDeprovisionWithoutDeployment(input: DeprovisionWithoutDeploymentRequest): Promise<LifecycleJobRecord> {
    const existing = await DeploymentRecord.findAggregateUnscoped({
      where: { endDate: null, server: { deviceId: input.deviceId } },
    });
    if (existing) {
      throw new BadRequestException('Device has an active deployment — end the rental instead of deprovisioning it');
    }

    return this.run({
      jobType: JobType.Deprovision,
      deviceId: input.deviceId,
      organizationId: null,
      performedBy: input.userId,
      source: input.source,
      triggeredByEmail: input.triggeredByEmail,
      payload: {},
      dispatch: (jobId) => this.deprovisionOperation.dispatchWithoutDeployment({ deviceId: input.deviceId, jobId }),
    });
  }

  async requestInterruptibleDeprovision(input: InterruptibleDeprovisionRequest): Promise<LifecycleJobRecord> {
    const { deploymentId } = await this.deprovisionOperation.assembleContext(input.deviceId, input.organizationId);

    const job: LifecycleJobRecord = LifecycleJobRecord.build({
      jobType: JobType.Deprovision,
      phase: LifecycleJobPhase.REQUESTED,
      deviceId: input.deviceId,
      deploymentId,
      organizationId: input.organizationId,
      performedBy: input.userId,
      source: input.source,
      payload: this.withAttribution(
        {
          interruptible: true,
          interruptionWarningTime: input.interruptionWarningTime,
          ...(input.gateOverride ? { gateOverride: true } : {}),
        },
        input.userId,
        input.source,
        input.triggeredByEmail,
      ),
    });
    await job.save();

    await this.scheduleInterruptibleDeprovision(job, deploymentId, input.organizationId, input.interruptionWarningTime);

    return job;
  }

  private async scheduleInterruptibleDeprovision(
    job: LifecycleJobRecord,
    deploymentId: string,
    organizationId: string,
    noticeMs: number,
    options?: { linkedJobId?: string },
  ): Promise<void> {
    const interruptAt = new Date(Date.now() + noticeMs);

    await this.markScheduledInterruption(deploymentId, organizationId, noticeMs);

    job.schedule(interruptAt);
    if (options?.linkedJobId) job.set({ linkedJobId: options.linkedJobId });
    await job.save();

    this.eventBus.emit('deployment.interruption.scheduled', {
      deploymentId,
      organizationId,
      interruptAt,
    });

    await this.scheduledQueue.add(
      RESUME_SCHEDULED_JOB,
      { jobId: job.data.id },
      {
        delay: noticeMs,
        jobId: job.data.id,
        attempts: SCHEDULED_RESUME_ATTEMPTS,
        backoff: { type: 'exponential', delay: SCHEDULED_RESUME_BACKOFF_MS },
      },
    );
  }

  async resumeScheduled(jobId: string): Promise<void> {
    const job: LifecycleJobRecord | null = await LifecycleJobRecord.findByIdUnscoped(jobId);
    if (!job) {
      this.logger.warn(`resumeScheduled: no LifecycleJob ${jobId}`);
      return;
    }
    if (job.data.phase !== LifecycleJobPhase.SCHEDULED) {
      this.logger.warn(`resumeScheduled: job ${jobId} is ${job.data.phase}, not SCHEDULED — skipping`);
      return;
    }

    const { deviceId, deploymentId, organizationId, performedBy } = job.data;
    if (!deviceId || !deploymentId || !organizationId || !performedBy) {
      throw new Error(`Scheduled job ${jobId} is missing device/deployment/organization/actor`);
    }

    // Phase writes are CAS claims: inbound results may drive the job forward concurrently — losing a claim means cede, never overwrite.
    if (
      !(await LifecycleJobRecord.claimTransition(jobId, LifecycleJobPhase.SCHEDULED, LifecycleJobPhase.AUTHORIZING))
    ) {
      this.logger.warn(`resumeScheduled: job ${jobId} left SCHEDULED concurrently — skipping`);
      return;
    }
    job.authorize();
    const deprovisionPayload = z.object({ gateOverride: z.literal(true).optional() }).safeParse(job.data.payload);
    const gateOverride = deprovisionPayload.success && deprovisionPayload.data.gateOverride === true;
    try {
      await this.runDeprovisionGate(
        jobId,
        deviceId,
        deploymentId,
        organizationId,
        gateOverride,
        gateOverride ? performedBy : undefined,
      );
    } catch (error) {
      await this.handleResumeFailure(job, deploymentId, organizationId, error);
      return;
    }

    if (
      !(await LifecycleJobRecord.claimTransition(jobId, LifecycleJobPhase.AUTHORIZING, LifecycleJobPhase.DISPATCHED))
    ) {
      this.logger.warn(`resumeScheduled: job ${jobId} resolved by inbound results mid-resume — skipping dispatch`);
      return;
    }
    job.dispatch();
    try {
      await this.clusterNetwork.detach(deploymentId, deviceId);
      await this.deprovisionOperation.dispatch({ deviceId, organizationId, deploymentId, jobId });
    } catch (error) {
      await this.handleResumeFailure(job, deploymentId, organizationId, error);
      return;
    }

    this.eventBus.emit('lifecycle.dispatched', {
      jobId: job.data.id,
      jobType: job.data.jobType,
      deviceId,
      deploymentId,
      organizationId,
      source: job.data.source,
      performedBy,
    });
  }

  async requestInterruptibleProvision(
    input: InterruptibleProvisionInput,
  ): Promise<InterruptibleProvisionRequestResult> {
    const request = ProvisionRequestSchema.parse(input.request);

    const outgoing = await DeploymentRecord.findAggregateUnscoped({
      where: { endDate: null, server: { deviceId: input.deviceId } },
    });
    if (!outgoing) {
      throw new NotFoundException('No active deployment to interrupt on this device');
    }

    if (!interruptibleEvictionRequiresApproval()) {
      const result = await this.executeInterruptibleProvision({
        deviceId: input.deviceId,
        request,
        expectedDeploymentId: outgoing.id,
      });
      return { status: 'executing', ...result };
    }

    const created = await ActiveRecordRegistry.client.adminLifecycleRequest.create({
      data: {
        type: AdminLifecycleRequestType.DEPROVISION,
        status: AdminLifecycleRequestStatus.PENDING,
        deploymentId: outgoing.id,
        deviceId: input.deviceId,
        requestedById: request.userId,
        requestBody: this.serializeRequest(request),
      },
      select: { id: true },
    });
    return { status: 'pending_approval', requestId: created.id };
  }

  async executeInterruptibleProvision(input: InterruptibleProvisionInput): Promise<InterruptibleProvisionResult> {
    const outgoing = await DeploymentRecord.findAggregateUnscoped({
      where: { endDate: null, server: { deviceId: input.deviceId } },
    });
    if (!outgoing) {
      throw new NotFoundException('No active deployment to interrupt on this device');
    }
    if (input.expectedDeploymentId && outgoing.id !== input.expectedDeploymentId) {
      throw new ConflictException(
        'The deployment captured for this eviction is no longer the active deployment on the device',
      );
    }
    if (!outgoing.isInterruptible) {
      throw new ConflictException('The active deployment on this device is not interruptible and cannot be evicted');
    }
    const outgoingDeploymentId = outgoing.id;
    const outgoingOrgId = outgoing.customerId;
    const noticeMs = outgoing.interruptibleNoticePeriod ?? DEFAULT_INTERRUPTIBLE_NOTICE_MS;

    const claimId = await this.createInterruptibleClaim(input, noticeMs);

    const incomingPayload: IncomingProvisionPayload = {
      interruptible: true,
      interruptibleClaimId: claimId,
      request: input.request,
    };
    const incomingJob: LifecycleJobRecord = LifecycleJobRecord.build({
      jobType: JobType.Provision,
      phase: LifecycleJobPhase.REQUESTED,
      deviceId: input.request.deviceId,
      organizationId: input.request.organizationId,
      performedBy: input.request.userId,
      source: input.request.source,
      payload: this.withAttribution(this.toJson(incomingPayload), input.request.userId, input.request.source),
    });
    await incomingJob.save();
    const incomingJobId = incomingJob.data.id;

    const deprovisionJob: LifecycleJobRecord = LifecycleJobRecord.build({
      jobType: JobType.Deprovision,
      phase: LifecycleJobPhase.REQUESTED,
      deviceId: input.deviceId,
      deploymentId: outgoingDeploymentId,
      organizationId: outgoingOrgId,
      performedBy: input.request.userId,
      source: input.request.source,
      payload: this.withAttribution(
        { interruptible: true, interruptionWarningTime: noticeMs },
        input.request.userId,
        input.request.source,
      ),
    });
    await deprovisionJob.save();

    await this.scheduleInterruptibleDeprovision(deprovisionJob, outgoingDeploymentId, outgoingOrgId, noticeMs, {
      linkedJobId: incomingJobId,
    });

    this.eventBus.emit('deployment.interruption.queued', {
      incomingOrgId: input.request.organizationId,
      deviceId: input.deviceId,
      deploymentName: input.request.deploymentName,
      delayMs: noticeMs,
    });

    return { deprovisionJobId: deprovisionJob.data.id, incomingJobId, claimId };
  }

  async enqueueLinkedProvision(linkedJobId: string): Promise<void> {
    await this.scheduledQueue.add(
      START_LINKED_PROVISION_JOB,
      { jobId: linkedJobId },
      {
        jobId: `${START_LINKED_PROVISION_JOB}-${linkedJobId}`,
        attempts: SCHEDULED_RESUME_ATTEMPTS,
        backoff: { type: 'exponential', delay: SCHEDULED_RESUME_BACKOFF_MS },
      },
    );
  }

  async startLinkedProvision(linkedJobId: string): Promise<void> {
    const job: LifecycleJobRecord | null = await LifecycleJobRecord.findByIdUnscoped(linkedJobId);
    if (!job) {
      this.logger.warn(`startLinkedProvision: no LifecycleJob ${linkedJobId}`);
      return;
    }
    if (job.data.phase !== LifecycleJobPhase.REQUESTED) {
      this.logger.warn(`startLinkedProvision: job ${linkedJobId} is ${job.data.phase}, not REQUESTED — skipping`);
      return;
    }

    const payload = this.parseIncomingProvisionPayload(job.data.payload);
    const request = payload.request;

    if (
      !(await LifecycleJobRecord.claimTransition(
        linkedJobId,
        LifecycleJobPhase.REQUESTED,
        LifecycleJobPhase.AUTHORIZING,
      ))
    ) {
      this.logger.warn(`startLinkedProvision: job ${linkedJobId} left REQUESTED concurrently — skipping`);
      return;
    }
    job.authorize();

    let reservationId: string | undefined;
    let deploymentId: string;
    let ctx: ProvisionContext;
    try {
      ctx = await this.provisionOperation.assembleContextForReplay(request);
      reservationId = await this.provisionOperation.createReservation(request);
      deploymentId = await this.provisionOperation.createDeployment(request, ctx.baseLayerId, reservationId);
      job.attachDeployment(deploymentId);
      await job.save();
    } catch (error) {
      await this.failLinkedProvision(job, payload.interruptibleClaimId, error, reservationId);
      return;
    }

    try {
      await this.gateBus.runGate('provision.authorize', {
        jobId: linkedJobId,
        deviceId: request.deviceId,
        deploymentId,
        organizationId: request.organizationId,
        customerUserId: request.userId,
        internalProvision: request.internalProvision ?? false,
      });
    } catch (error) {
      if (error instanceof LifecycleGateDeferral) {
        if (
          await LifecycleJobRecord.claimTransition(
            linkedJobId,
            LifecycleJobPhase.AUTHORIZING,
            LifecycleJobPhase.DEFERRED,
          )
        ) {
          job.defer();
          this.eventBus.emit('lifecycle.deferred', {
            jobId: linkedJobId,
            jobType: JobType.Provision,
            deviceId: request.deviceId,
            deploymentId,
            organizationId: request.organizationId,
            source: request.source,
            performedBy: request.userId,
            reason: error.reason,
          });
        } else {
          this.logger.warn(`startLinkedProvision: job ${linkedJobId} left AUTHORIZING concurrently — skipping defer`);
        }
        return;
      }
      await this.failLinkedProvision(job, payload.interruptibleClaimId, error, reservationId);
      return;
    }

    if (
      !(await LifecycleJobRecord.claimTransition(
        linkedJobId,
        LifecycleJobPhase.AUTHORIZING,
        LifecycleJobPhase.DISPATCHED,
      ))
    ) {
      this.logger.warn(`startLinkedProvision: job ${linkedJobId} resolved concurrently — skipping dispatch`);
      return;
    }
    job.dispatch();
    try {
      await this.clusterNetwork.attach(deploymentId, request.deviceId);
      try {
        await this.provisionOperation.publish(request, deploymentId, ctx.pubkeys, linkedJobId);
      } catch (error) {
        await this.clusterNetwork.detach(deploymentId, request.deviceId);
        throw error;
      }
    } catch (error) {
      await this.failLinkedProvision(job, payload.interruptibleClaimId, error, reservationId);
      return;
    }

    await this.completeInterruptibleClaim(payload.interruptibleClaimId);

    this.eventBus.emit('provision.started', {
      jobId: linkedJobId,
      deviceId: request.deviceId,
      deploymentId,
      organizationId: request.organizationId,
    });

    this.eventBus.emit('lifecycle.dispatched', {
      jobId: linkedJobId,
      jobType: JobType.Provision,
      deviceId: request.deviceId,
      deploymentId,
      organizationId: request.organizationId,
      source: request.source,
      performedBy: request.userId,
    });
  }

  async abortLinkedProvision(linkedJobId: string, reason: string): Promise<void> {
    const job: LifecycleJobRecord | null = await LifecycleJobRecord.findByIdUnscoped(linkedJobId);
    if (!job) return;

    const claimId = this.tryReadClaimId(job.data.payload);
    const from = job.data.phase;
    if (
      from !== LifecycleJobPhase.REQUESTED &&
      from !== LifecycleJobPhase.AUTHORIZING &&
      from !== LifecycleJobPhase.DEFERRED
    ) {
      this.logger.warn(`abortLinkedProvision: job ${linkedJobId} is ${from} — not a parked provision, skipping`);
      return;
    }
    const claimed = await LifecycleJobRecord.claimTransition(linkedJobId, from, LifecycleJobPhase.ABORTED, reason);
    if (!claimed) {
      this.logger.warn(`abortLinkedProvision: job ${linkedJobId} resolved concurrently — skipping abort`);
      return;
    }
    job.abort(reason);
    this.emitRequestFailure(job);
    if (job.data.deploymentId) await this.endReservationForDeployment(job.data.deploymentId);
    if (claimId) await this.releaseInterruptibleClaim(claimId);
    this.logger.warn(`abortLinkedProvision: job ${linkedJobId} aborted: ${reason}`);
  }

  async resumeDeferred(jobId: string): Promise<boolean> {
    const job: LifecycleJobRecord | null = await LifecycleJobRecord.findByIdUnscoped(jobId);
    if (!job) {
      this.logger.warn(`resumeDeferred: no LifecycleJob ${jobId}`);
      return false;
    }
    if (job.data.phase !== LifecycleJobPhase.DEFERRED) {
      this.logger.warn(`resumeDeferred: job ${jobId} is ${job.data.phase}, not DEFERRED — skipping`);
      return false;
    }
    if (job.data.jobType !== JobType.Provision) {
      throw new BadRequestException(`resumeDeferred supports only Provision jobs; job ${jobId} is ${job.data.jobType}`);
    }

    const { deviceId, deploymentId, organizationId, performedBy } = job.data;
    if (!deviceId || !deploymentId || !organizationId || !performedBy) {
      throw new Error(`Deferred provision ${jobId} is missing device/deployment/organization/actor`);
    }

    const request = this.parseDeferredProvisionRequest(job.data.payload);
    const claimId = this.tryReadClaimId(job.data.payload);
    const ctx = await this.provisionOperation.assembleContextForResume(request);

    if (!(await LifecycleJobRecord.claimTransition(jobId, LifecycleJobPhase.DEFERRED, LifecycleJobPhase.AUTHORIZING))) {
      this.logger.warn(`resumeDeferred: job ${jobId} left DEFERRED concurrently — skipping`);
      return false;
    }
    job.authorize();

    // A crash between the two claims strands the job in AUTHORIZING; the stuck-sweep reaps it — no in-process rollback needed.
    if (
      !(await LifecycleJobRecord.claimTransition(jobId, LifecycleJobPhase.AUTHORIZING, LifecycleJobPhase.DISPATCHED))
    ) {
      this.logger.warn(`resumeDeferred: job ${jobId} resolved concurrently — skipping dispatch`);
      return false;
    }
    job.dispatch();
    try {
      await this.clusterNetwork.attach(deploymentId, request.deviceId);
      try {
        await this.provisionOperation.publish(request, deploymentId, ctx.pubkeys, jobId);
      } catch (error) {
        await this.clusterNetwork.detach(deploymentId, request.deviceId);
        throw error;
      }
    } catch (error) {
      job.fail(getErrorMessage(error));
      await job.save();
      this.emitRequestFailure(job);
      await this.endReservationForDeployment(deploymentId);
      if (claimId) await this.releaseInterruptibleClaim(claimId);
      throw error;
    }

    if (claimId) {
      await this.completeInterruptibleClaim(claimId);
      this.eventBus.emit('provision.started', { jobId, deviceId, deploymentId, organizationId });
    }

    this.eventBus.emit('lifecycle.dispatched', {
      jobId,
      jobType: JobType.Provision,
      deviceId,
      deploymentId,
      organizationId,
      source: job.data.source,
      performedBy,
    });
    return true;
  }

  async abortDeferred(jobId: string, reason: string): Promise<boolean> {
    const job: LifecycleJobRecord | null = await LifecycleJobRecord.findByIdUnscoped(jobId);
    if (!job) {
      this.logger.warn(`abortDeferred: no LifecycleJob ${jobId}`);
      return false;
    }
    if (job.data.phase !== LifecycleJobPhase.DEFERRED) {
      this.logger.warn(`abortDeferred: job ${jobId} is ${job.data.phase}, not DEFERRED — skipping`);
      return false;
    }

    if (
      !(await LifecycleJobRecord.claimTransition(jobId, LifecycleJobPhase.DEFERRED, LifecycleJobPhase.ABORTED, reason))
    ) {
      this.logger.warn(`abortDeferred: job ${jobId} resolved concurrently — skipping abort`);
      return false;
    }
    job.abort(reason);
    this.emitRequestFailure(job);
    if (job.data.deploymentId) await this.endReservationForDeployment(job.data.deploymentId);
    const claimId = this.tryReadClaimId(job.data.payload);
    if (claimId) await this.releaseInterruptibleClaim(claimId);
    this.logger.warn(`abortDeferred: job ${jobId} aborted: ${reason}`);
    return true;
  }

  private async endReservationQuietly(reservationId: string): Promise<void> {
    try {
      await this.reservationsService.endReservation(reservationId);
    } catch (error) {
      this.logger.error(`Failed to compensate reservation ${reservationId}: ${getErrorMessage(error)}`);
    }
  }

  private async endReservationForDeployment(deploymentId: string): Promise<void> {
    const deployment: DeploymentRecord | null = await DeploymentRecord.findOneUnscoped({ where: { id: deploymentId } });
    const reservationId = deployment?.data.reservationId ?? null;
    if (reservationId) await this.endReservationQuietly(reservationId);
  }

  private parseDeferredProvisionRequest(payload: unknown): ProvisionRequest {
    const parsed = z.object({ request: ProvisionRequestSchema }).safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Deferred provision payload missing a valid request: ${parsed.error.message}`);
    }
    return parsed.data.request;
  }

  private async failLinkedProvision(
    job: LifecycleJobRecord,
    claimId: string,
    error: unknown,
    reservationId?: string,
  ): Promise<void> {
    if (reservationId) await this.endReservationQuietly(reservationId);
    if (this.isPermanentResumeFailure(error)) {
      const to = job.data.phase === LifecycleJobPhase.DISPATCHED ? LifecycleJobPhase.FAILED : LifecycleJobPhase.ABORTED;
      const claimed = await LifecycleJobRecord.claimTransition(job.data.id, job.data.phase, to, getErrorMessage(error));
      if (!claimed) {
        this.logger.warn(
          `startLinkedProvision: job ${job.data.id} resolved concurrently — dropping permanent failure: ${getErrorMessage(error)}`,
        );
        return;
      }
      if (to === LifecycleJobPhase.FAILED) job.fail(getErrorMessage(error));
      else job.abort(getErrorMessage(error));
      this.emitRequestFailure(job);
      await this.releaseInterruptibleClaim(claimId);
      this.logger.warn(`startLinkedProvision: job ${job.data.id} terminated (permanent): ${getErrorMessage(error)}`);
      return;
    }
    throw error;
  }

  private async createInterruptibleClaim(input: InterruptibleProvisionInput, noticeMs: number): Promise<string> {
    try {
      const claim = await ActiveRecordRegistry.client.interruptibleClaim.create({
        data: {
          deploymentName: input.request.deploymentName,
          status: InterruptibleClaimStatus.Pending,
          interruptAt: new Date(Date.now() + noticeMs),
          server: { connect: { deviceId: input.deviceId } },
          organization: { connect: { id: input.request.organizationId } },
          user: { connect: { id: input.request.userId } },
        },
        select: { id: true },
      });
      return claim.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('host already has a pending interruptible claim');
      }
      throw error;
    }
  }

  private async completeInterruptibleClaim(claimId: string): Promise<void> {
    await ActiveRecordRegistry.client.interruptibleClaim.update({
      where: { id: claimId },
      data: { status: InterruptibleClaimStatus.Complete },
    });
  }

  // The partial unique index only guards Pending rows — release must delete, not flip status.
  private async releaseInterruptibleClaim(claimId: string): Promise<void> {
    try {
      await ActiveRecordRegistry.client.interruptibleClaim.delete({ where: { id: claimId } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') return;
      throw error;
    }
  }

  private parseIncomingProvisionPayload(payload: unknown): IncomingProvisionPayload {
    return IncomingProvisionPayloadSchema.parse(payload);
  }

  private tryReadClaimId(payload: unknown): string | null {
    const parsed = z.object({ interruptibleClaimId: z.string() }).safeParse(payload);
    return parsed.success ? parsed.data.interruptibleClaimId : null;
  }

  private toJson(value: IncomingProvisionPayload): Prisma.JsonObject {
    return JSON.parse(JSON.stringify(value));
  }

  private serializeRequest(value: ProvisionRequest | ReprovisionRequest): Prisma.JsonObject {
    return JSON.parse(JSON.stringify(value));
  }

  // Retry-only fields; `triggeredByEmail` reaches the payload through `withAttribution`.
  private auditPayload(audit?: LifecycleJobAudit): Record<string, string> {
    if (!audit) return {};
    const extra: Record<string, string> = {};
    if (audit.retriedFromJobId) extra.retriedFromJobId = audit.retriedFromJobId;
    if (audit.retriedBy) extra.retriedBy = audit.retriedBy;
    return extra;
  }

  private withAttribution(
    payload: Prisma.JsonObject,
    performedBy: string,
    source: RequestSource,
    triggeredByEmail?: string,
  ): Prisma.InputJsonValue {
    const attribution: Record<string, string> = { triggeredBy: performedBy, source };
    if (triggeredByEmail) attribution.triggeredByEmail = triggeredByEmail;
    return { ...payload, ...attribution };
  }

  /** Transient failures rewind to SCHEDULED and rethrow for BullMQ retry (the grace timer fires only once); permanent failures terminalize and swallow. */
  private async handleResumeFailure(
    job: LifecycleJobRecord,
    deploymentId: string,
    organizationId: string,
    error: unknown,
  ): Promise<void> {
    if (this.isPermanentResumeFailure(error)) {
      const to = job.data.phase === LifecycleJobPhase.DISPATCHED ? LifecycleJobPhase.FAILED : LifecycleJobPhase.ABORTED;
      const claimed = await LifecycleJobRecord.claimTransition(job.data.id, job.data.phase, to, getErrorMessage(error));
      if (!claimed) {
        this.logger.warn(
          `resumeScheduled: job ${job.data.id} resolved concurrently — dropping permanent failure: ${getErrorMessage(error)}`,
        );
        return;
      }
      if (to === LifecycleJobPhase.FAILED) job.fail(getErrorMessage(error));
      else job.abort(getErrorMessage(error));
      await DeploymentRecord.clearScheduledInterruption(deploymentId, organizationId);
      this.logger.warn(`resumeScheduled: job ${job.data.id} terminated (permanent): ${getErrorMessage(error)}`);
      return;
    }
    const claimed = await LifecycleJobRecord.claimTransition(job.data.id, job.data.phase, LifecycleJobPhase.SCHEDULED);
    if (!claimed) {
      this.logger.warn(`resumeScheduled: job ${job.data.id} resolved concurrently — dropping transient retry`);
      return;
    }
    job.reschedule();
    throw error;
  }

  // GateUnavailableError is a fail-closed deny, not a retryable outage.
  private isPermanentResumeFailure(error: unknown): boolean {
    return (
      error instanceof LifecycleGateRejection ||
      error instanceof GateUnavailableError ||
      error instanceof BadRequestException ||
      error instanceof NotFoundException
    );
  }

  private runDeprovisionGate(
    jobId: string,
    deviceId: string,
    deploymentId: string,
    organizationId: string,
    override = false,
    overrideBy?: string,
  ): Promise<void> {
    return this.gateBus.runGate(
      'deprovision.authorize',
      { jobId, deviceId, deploymentId, organizationId },
      { override, overrideBy },
    );
  }

  private async markScheduledInterruption(
    deploymentId: string,
    organizationId: string,
    warningMs: number,
  ): Promise<void> {
    const record: DeploymentRecord | null = await DeploymentRecord.findOneUnscoped({
      where: { id: deploymentId, customerId: organizationId, endDate: null },
    });
    if (record) {
      record.setScheduledInterruptionTime(warningMs);
      await record.save();
    }
  }

  /** A system job has no actor, deployment or gate — nothing to bill, defer or emit; the row exists so inbound results correlate and the timeline is queryable. */
  async runSystem(params: RunSystemParams): Promise<LifecycleJobRecord> {
    const job: LifecycleJobRecord = LifecycleJobRecord.build({
      jobType: params.jobType,
      phase: LifecycleJobPhase.REQUESTED,
      deviceId: params.deviceId,
      deploymentId: null,
      organizationId: null,
      performedBy: null,
      source: RequestSource.SYSTEM,
      payload: { source: params.source, zoneId: params.zoneId },
    });
    await job.save();
    await this.proceed(job, { dispatch: params.dispatch });
    return job;
  }

  private async run(params: RunParams): Promise<LifecycleJobRecord> {
    const job: LifecycleJobRecord = LifecycleJobRecord.build({
      jobType: params.jobType,
      phase: LifecycleJobPhase.REQUESTED,
      deviceId: params.deviceId,
      deploymentId: params.deploymentId ?? null,
      organizationId: params.organizationId,
      performedBy: params.performedBy,
      source: params.source,
      payload: this.withAttribution(params.payload, params.performedBy, params.source, params.triggeredByEmail),
    });
    await job.save();

    let prep: PrepareResult = {};
    if (params.prepare) {
      try {
        prep = await params.prepare(job.data.id);
        if (prep.deploymentId) {
          job.attachDeployment(prep.deploymentId);
          await job.save();
        }
      } catch (error) {
        job.abort(getErrorMessage(error));
        await job.save();
        this.emitRequestFailure(job);
        throw error;
      }
    }

    let dispatchEntered = false;
    let result: { outcome: 'dispatched' } | { outcome: 'deferred'; reason: string };
    try {
      result = await this.proceed(job, {
        gate: params.gate ? (jobId) => params.gate!(jobId, prep, params.gateOverride ?? false) : undefined,
        dispatch: (jobId) => {
          dispatchEntered = true;
          return params.dispatch(jobId, prep);
        },
      });
    } catch (error) {
      // The bridge never accepted the job, so inbound will never fire — signal the orphaned Deployment for billing's refund compensation here.
      this.emitRequestFailure(job);
      if (prep.reservationId) await this.endReservationQuietly(prep.reservationId);
      if (dispatchEntered && POWER_FAMILY.has(params.jobType)) {
        try {
          await ActiveRecordRegistry.client.server.updateMany({
            where: {
              deviceId: params.deviceId,
              powerStatus: { in: [...TRANSITIONAL_SERVER_POWER_STATUSES] },
              device: { lastJobId: job.data.id },
            },
            data: { powerStatus: null },
          });
        } catch (resetError) {
          this.logger.error(
            `Failed to reset transitional powerStatus for device ${params.deviceId}: ${getErrorMessage(resetError)}`,
          );
        }
      }
      throw error;
    }

    if (result.outcome === 'deferred') {
      this.eventBus.emit('lifecycle.deferred', {
        jobId: job.data.id,
        jobType: params.jobType,
        deviceId: params.deviceId,
        deploymentId: job.data.deploymentId ?? null,
        organizationId: params.organizationId,
        source: params.source,
        performedBy: params.performedBy,
        reason: result.reason,
      });
      return job;
    }

    if (POWER_FAMILY.has(params.jobType)) {
      await this.watchdogQueue.add(
        POWER_WATCHDOG_JOB,
        { jobId: job.data.id },
        { delay: POWER_SAGA_DEADLINE_MS, jobId: job.data.id },
      );
    }

    this.eventBus.emit('lifecycle.dispatched', {
      jobId: job.data.id,
      jobType: params.jobType,
      deviceId: params.deviceId,
      deploymentId: job.data.deploymentId ?? null,
      organizationId: params.organizationId,
      source: params.source,
      performedBy: params.performedBy,
    });

    return job;
  }

  private emitRequestFailure(job: LifecycleJobRecord): void {
    const jobType = job.data.jobType;
    if (jobType !== JobType.Provision && jobType !== JobType.Reprovision) return;
    if (jobType === JobType.Provision && !job.data.deploymentId) return;
    this.eventBus.emit('provision.failed', {
      jobId: job.data.id,
      jobType,
      deviceId: job.data.deviceId,
      deploymentId: job.data.deploymentId,
      organizationId: job.data.organizationId,
      error: job.data.error ?? 'lifecycle request failed before dispatch',
    });
  }

  private async proceed(
    job: LifecycleJobRecord,
    ops: { gate?: (jobId: string) => Promise<void>; dispatch: (jobId: string) => Promise<void> },
  ): Promise<{ outcome: 'dispatched' } | { outcome: 'deferred'; reason: string }> {
    job.authorize();
    await job.save();

    if (ops.gate) {
      try {
        await ops.gate(job.data.id);
      } catch (error) {
        if (error instanceof LifecycleGateDeferral) {
          if (job.data.jobType === JobType.Provision) {
            job.defer();
            await job.save();
            return { outcome: 'deferred', reason: error.reason };
          }
          this.logger.warn(
            `proceed: gate deferred a ${job.data.jobType} job (${job.data.id}) that cannot be resumed — rejecting`,
          );
          job.abort(error.reason);
          await job.save();
          throw new LifecycleGateRejection(
            `${job.data.jobType} jobs cannot be deferred (resume unsupported): ${error.reason}`,
          );
        }
        job.abort(getErrorMessage(error));
        await job.save();
        throw error;
      }
    }

    job.dispatch();
    await job.save();
    try {
      await ops.dispatch(job.data.id);
    } catch (error) {
      job.fail(getErrorMessage(error));
      await job.save();
      throw error;
    }
    return { outcome: 'dispatched' };
  }

  private requireDeploymentId(deploymentId: string | null | undefined, context: string): string {
    if (!deploymentId) {
      throw new Error(`Missing deployment id for ${context}`);
    }
    return deploymentId;
  }
}
