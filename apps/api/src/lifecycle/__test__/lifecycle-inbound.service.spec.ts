import { PLUGIN_EVENT_BUS } from '@hydrahost/plugin-sdk';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { ActiveRecordRegistry } from '@repo/active-record';
import {
  DeviceTokenRevocationReason,
  JobType,
  LifecycleJobPhase,
  RequestSource,
  ServerLifecycleStatus,
  ServerPowerStatus,
} from '@repo/database';
import { LIFECYCLE_WATCHDOG_QUEUE, LifecycleJobRecord } from '@repo/lifecycle';
import type { JobCompletedData, JobResultData } from 'src/brokkr-bridge/types/queue.types';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { ReservationRecord } from 'src/reservations/reservation.record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleInboundService } from '../inbound/lifecycle-inbound.service';
import { LifecycleService } from '../lifecycle.service';
import { jobAt, makeMockClient } from './test-helpers';

const stepResult = (over: Partial<JobResultData> = {}): JobResultData => ({
  plan_id: 'job-1',
  step_name: 'prepare_storage',
  status: 'running',
  device_id: '123',
  zone_prefix: 'z',
  event_type: 'stage_changed',
  action_type: 'provision',
  attempt: 0,
  timestamp: Date.now() / 1000,
  ...over,
});

const jobCompleted = (over: Partial<JobCompletedData> = {}): JobCompletedData => ({
  plan_id: 'job-1',
  device_id: '123',
  zone_prefix: 'z',
  saga_name: 'provision',
  status: 'complete',
  timestamp: Date.now() / 1000,
  ...over,
});

describe('LifecycleInboundService', () => {
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  const prismaTx = { tx: true };
  const prisma = {
    device: { update: vi.fn().mockResolvedValue({}) },
    server: {
      findUnique: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaTx)),
  };
  const watchdogQueue = { add: vi.fn().mockResolvedValue({ id: 'bull-1' }) };
  const lifecycleService = {
    enqueueLinkedProvision: vi.fn().mockResolvedValue(undefined),
    abortLinkedProvision: vi.fn().mockResolvedValue(undefined),
  };
  const deviceTokens = {
    runWithDeploymentTokenRevocation: vi
      .fn()
      .mockImplementation(async (_args: unknown, action: (tx: unknown) => Promise<unknown>) => action(prismaTx)),
  };

  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

  let service: LifecycleInboundService;
  let appendEvent: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prisma.server.findUnique.mockResolvedValue(null);
    ActiveRecordRegistry.configureForTest(makeMockClient(), null);
    appendEvent = vi.spyOn(LifecycleJobRecord, 'appendEvent').mockResolvedValue(undefined as never);
    vi.spyOn(LifecycleJobRecord, 'claimTransition').mockResolvedValue(true);
    vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(null);
    vi.spyOn(DeploymentRecord, 'clearScheduledInterruption').mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleInboundService,
        { provide: PLUGIN_EVENT_BUS, useValue: eventBus },
        { provide: PrismaClient, useValue: prisma },
        { provide: getQueueToken(LIFECYCLE_WATCHDOG_QUEUE), useValue: watchdogQueue },
        { provide: LifecycleService, useValue: lifecycleService },
        { provide: DeviceTokensService, useValue: deviceTokens },
        { provide: 'LoggerServiceLifecycleInboundService', useValue: logger },
      ],
    }).compile();
    service = moduleRef.get(LifecycleInboundService);
  });

  afterEach(() => {
    ActiveRecordRegistry.configureForTest(null, null);
  });

  it('stage_changed advances DISPATCHED → RUNNING, records the event, no device write/emit', async () => {
    const job = jobAt(LifecycleJobPhase.DISPATCHED);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyStepResult(stepResult());

    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'job-1', eventType: 'stage_changed' }));
    expect(job.data.phase).toBe(LifecycleJobPhase.RUNNING);
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('reads the bridge stamp as the seconds it sends, not as milliseconds', async () => {
    const job = jobAt(LifecycleJobPhase.DISPATCHED);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
    const sentAt = new Date('2026-08-11T18:45:12.000Z');

    await service.applyStepResult(stepResult({ timestamp: sentAt.getTime() / 1000 }));

    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: sentAt }));
  });

  it('does not land a step event two generations early, which a seconds-as-ms read would', async () => {
    const job = jobAt(LifecycleJobPhase.DISPATCHED);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyStepResult(stepResult({ timestamp: Date.now() / 1000 }));

    const { occurredAt } = appendEvent.mock.calls[0][0] as { occurredAt: Date };
    expect(occurredAt.getUTCFullYear()).toBe(new Date().getUTCFullYear());
    expect(Math.abs(Date.now() - occurredAt.getTime())).toBeLessThan(60_000);
  });

  it('reads a saga completion stamp as seconds too', async () => {
    const job = jobAt(LifecycleJobPhase.RUNNING);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
    const sentAt = new Date('2026-08-11T18:45:12.000Z');

    await service.applyJobCompleted(jobCompleted({ timestamp: sentAt.getTime() / 1000 }));

    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ occurredAt: sentAt }));
  });

  it('warns when a stamp lands a day out, so a wire unit change cannot pass silently', async () => {
    const job = jobAt(LifecycleJobPhase.DISPATCHED);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyStepResult(stepResult({ timestamp: Date.now() }));

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('check the wire unit'));
  });

  it('stays quiet for a stamp in the right unit', async () => {
    const job = jobAt(LifecycleJobPhase.DISPATCHED);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyStepResult(stepResult({ timestamp: Date.now() / 1000 }));

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('job_failed fails a provision and marks the device FAILED + emits provision.failed', async () => {
    const job = jobAt(LifecycleJobPhase.DISPATCHED);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyStepResult(
      stepResult({ event_type: 'job_failed', status: 'failed', error: { message: 'boom' } }),
    );

    expect(job.data.phase).toBe(LifecycleJobPhase.FAILED);
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: {
        lastJobId: 'job-1',
        server: {
          upsert: {
            create: { lifecycleStatus: ServerLifecycleStatus.FAILED },
            update: { lifecycleStatus: ServerLifecycleStatus.FAILED },
          },
        },
      },
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      'provision.failed',
      expect.objectContaining({ jobId: 'job-1', error: 'boom' }),
    );
  });

  it('provision job.completed advances RUNNING → AWAITING_PHONE_HOME (no device write, no completion emit)', async () => {
    const job = jobAt(LifecycleJobPhase.RUNNING);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyJobCompleted(jobCompleted());

    expect(job.data.phase).toBe(LifecycleJobPhase.AWAITING_PHONE_HOME);
    expect(job.data.phoneHomeDeadline).toBeInstanceOf(Date);
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(watchdogQueue.add).toHaveBeenCalledWith(
      'phone-home-watchdog',
      { jobId: 'job-1' },
      expect.objectContaining({ jobId: 'job-1' }),
    );
  });

  it('provision job.completed from DISPATCHED normalizes via RUNNING and reaches AWAITING_PHONE_HOME', async () => {
    const job = jobAt(LifecycleJobPhase.DISPATCHED);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyJobCompleted(jobCompleted());

    expect(job.data.phase).toBe(LifecycleJobPhase.AWAITING_PHONE_HOME);
    expect(job.data.phoneHomeDeadline).toBeInstanceOf(Date);
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
    expect(watchdogQueue.add).toHaveBeenCalledWith(
      'phone-home-watchdog',
      { jobId: 'job-1' },
      expect.objectContaining({ jobId: 'job-1' }),
    );
  });

  it('provision job.completed completes immediately when the phone-home already landed (server PROVISIONED)', async () => {
    prisma.server.findUnique.mockResolvedValueOnce({ lifecycleStatus: ServerLifecycleStatus.PROVISIONED });
    const job = jobAt(LifecycleJobPhase.RUNNING);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyJobCompleted(jobCompleted());

    expect(job.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(watchdogQueue.add).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith('provision.completed', expect.objectContaining({ jobId: 'job-1' }));
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', eventType: 'phone_home', status: 'complete' }),
    );
  });

  it('deprovision job.completed completes the job, sets device INVENTORY, emits deprovision.completed', async () => {
    const job = jobAt(LifecycleJobPhase.RUNNING, JobType.Deprovision);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyJobCompleted(jobCompleted({ saga_name: 'deprovision' }));

    expect(job.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: {
        lastJobId: 'job-1',
        server: {
          upsert: {
            create: { lifecycleStatus: ServerLifecycleStatus.INVENTORY },
            update: { lifecycleStatus: ServerLifecycleStatus.INVENTORY },
          },
        },
      },
    });
    expect(eventBus.emit).toHaveBeenCalledWith('deprovision.completed', expect.objectContaining({ jobId: 'job-1' }));
  });

  it('deprovision job_failed quarantines the host (FAILED) and emits deprovision.failed remediation signal', async () => {
    const job = jobAt(LifecycleJobPhase.RUNNING, JobType.Deprovision);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyStepResult(
      stepResult({
        action_type: 'deprovision',
        event_type: 'job_failed',
        status: 'failed',
        error: { message: 'wipe failed' },
      }),
    );

    expect(job.data.phase).toBe(LifecycleJobPhase.FAILED);
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: {
        lastJobId: 'job-1',
        server: {
          upsert: {
            create: { lifecycleStatus: ServerLifecycleStatus.FAILED },
            update: { lifecycleStatus: ServerLifecycleStatus.FAILED },
          },
        },
      },
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      'deprovision.failed',
      expect.objectContaining({
        jobId: 'job-1',
        deviceId: 'device-1',
        deploymentId: 'dep-1',
        organizationId: 'org-1',
        error: 'wipe failed',
      }),
    );
    expect(eventBus.emit).not.toHaveBeenCalledWith('deprovision.completed', expect.anything());
  });

  it('scheduled deprovision job_failed quarantines the host (FAILED) and emits deprovision.failed remediation signal', async () => {
    const job = LifecycleJobRecord.build({
      id: 'job-1',
      jobType: JobType.Deprovision,
      phase: LifecycleJobPhase.SCHEDULED,
      deviceId: 'device-1',
      deploymentId: 'dep-1',
      organizationId: 'org-1',
      performedBy: 'user-1',
      source: RequestSource.API,
      payload: {},
      scheduledAt: new Date(),
    });
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyStepResult(
      stepResult({
        action_type: 'deprovision',
        event_type: 'job_failed',
        status: 'failed',
        error: { message: 'wipe failed' },
      }),
    );

    expect(job.data.phase).toBe(LifecycleJobPhase.FAILED);
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: {
        lastJobId: 'job-1',
        server: {
          upsert: {
            create: { lifecycleStatus: ServerLifecycleStatus.FAILED },
            update: { lifecycleStatus: ServerLifecycleStatus.FAILED },
          },
        },
      },
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      'deprovision.failed',
      expect.objectContaining({
        jobId: 'job-1',
        deviceId: 'device-1',
        deploymentId: 'dep-1',
        organizationId: 'org-1',
        error: 'wipe failed',
      }),
    );
    expect(eventBus.emit).not.toHaveBeenCalledWith('deprovision.completed', expect.anything());
  });

  describe('linked interruptible-provision chaining', () => {
    function linkedDeprovision(phase: LifecycleJobPhase) {
      return LifecycleJobRecord.build({
        id: 'deprovision-1',
        jobType: JobType.Deprovision,
        phase,
        deviceId: 'host-device',
        deploymentId: 'outgoing-dep',
        organizationId: 'outgoing-org',
        performedBy: 'incoming-user',
        source: RequestSource.API,
        payload: {},
        scheduledAt: new Date(),
        linkedJobId: 'incoming-1',
      });
    }

    it('starts the linked provision once when the outgoing deprovision COMPLETES', async () => {
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(linkedDeprovision(LifecycleJobPhase.RUNNING));

      await service.applyJobCompleted(jobCompleted({ plan_id: 'deprovision-1', saga_name: 'deprovision' }));

      expect(lifecycleService.enqueueLinkedProvision).toHaveBeenCalledTimes(1);
      expect(lifecycleService.enqueueLinkedProvision).toHaveBeenCalledWith('incoming-1');
      expect(lifecycleService.abortLinkedProvision).not.toHaveBeenCalled();
    });

    it('does not chain a deprovision with no linkedJobId', async () => {
      vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(
        jobAt(LifecycleJobPhase.RUNNING, JobType.Deprovision),
      );

      await service.applyJobCompleted(jobCompleted({ saga_name: 'deprovision' }));

      expect(lifecycleService.enqueueLinkedProvision).not.toHaveBeenCalled();
    });

    it('aborts the parked incoming provision when a linked deprovision is swept to ABORTED', async () => {
      const job = linkedDeprovision(LifecycleJobPhase.SCHEDULED);
      job.set({ scheduledAt: new Date(Date.now() - 60 * 60 * 1000) });
      vi.spyOn(LifecycleJobRecord, 'findManyUnscoped').mockResolvedValue([job]);
      vi.spyOn(LifecycleJobRecord, 'claimTransition').mockResolvedValue(true);

      await service.sweepStuckJobs();

      expect(job.data.phase).toBe(LifecycleJobPhase.ABORTED);
      expect(lifecycleService.abortLinkedProvision).toHaveBeenCalledTimes(1);
      expect(lifecycleService.abortLinkedProvision).toHaveBeenCalledWith(
        'incoming-1',
        expect.stringContaining('deprovision-1'),
      );
      expect(lifecycleService.enqueueLinkedProvision).not.toHaveBeenCalled();
      expect(eventBus.emit).not.toHaveBeenCalledWith('deprovision.failed', expect.anything());
    });
  });

  it('power_off job.completed settles the device to Off', async () => {
    const job = jobAt(LifecycleJobPhase.RUNNING, JobType.PowerOff);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyJobCompleted(jobCompleted({ saga_name: 'power_off' }));

    expect(job.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: {
        lastJobId: 'job-1',
        server: {
          upsert: {
            create: { powerStatus: ServerPowerStatus.Off },
            update: { powerStatus: ServerPowerStatus.Off },
          },
        },
      },
    });
  });

  it('power_on job.completed leaves the transitional power state for heartbeat to resolve', async () => {
    const job = jobAt(LifecycleJobPhase.RUNNING, JobType.PowerOn);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyJobCompleted(jobCompleted({ saga_name: 'power_on' }));

    expect(job.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('reboot job.completed leaves the transitional power state for phone-home to resolve', async () => {
    const job = jobAt(LifecycleJobPhase.RUNNING, JobType.Reboot);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyJobCompleted(jobCompleted({ saga_name: 'reboot' }));

    expect(job.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('emits deployment.interruption.completed when a scheduled (interruptible) deprovision completes', async () => {
    const job = LifecycleJobRecord.build({
      id: 'job-1',
      jobType: JobType.Deprovision,
      phase: LifecycleJobPhase.RUNNING,
      deviceId: 'device-1',
      deploymentId: 'dep-1',
      organizationId: 'org-1',
      performedBy: 'user-1',
      source: RequestSource.API,
      payload: {},
      scheduledAt: new Date(),
    });
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyJobCompleted(jobCompleted({ saga_name: 'deprovision' }));

    expect(eventBus.emit).toHaveBeenCalledWith('deprovision.completed', expect.objectContaining({ jobId: 'job-1' }));
    expect(eventBus.emit).toHaveBeenCalledWith(
      'deployment.interruption.completed',
      expect.objectContaining({ deploymentId: 'dep-1', organizationId: 'org-1' }),
    );
  });

  it('stage_changed for a rewound (SCHEDULED) job normalizes it forward to RUNNING', async () => {
    const job = jobAt(LifecycleJobPhase.SCHEDULED, JobType.Deprovision);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyStepResult(stepResult({ action_type: 'deprovision' }));

    expect(job.data.phase).toBe(LifecycleJobPhase.RUNNING);
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('job.completed for a rewound (SCHEDULED) deprovision completes it and ends the still-open deployment', async () => {
    const job = jobAt(LifecycleJobPhase.SCHEDULED, JobType.Deprovision);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
    const deployment = {
      data: { reservationId: 'res-1' },
      endDeployment: vi.fn().mockReturnThis(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
      deployment as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>,
    );
    const endReservation = vi.spyOn(ReservationRecord, 'endActiveByIdUnscoped').mockResolvedValue(true);

    await service.applyJobCompleted(jobCompleted({ saga_name: 'deprovision' }));

    expect(job.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(deployment.endDeployment).toHaveBeenCalled();
    expect(deployment.save).toHaveBeenCalledWith({ tx: prismaTx });
    expect(endReservation).toHaveBeenCalledWith('res-1', prismaTx);
    expect(eventBus.emit).toHaveBeenCalledWith('deprovision.completed', expect.objectContaining({ jobId: 'job-1' }));
  });

  it('deprovision job.completed ends the linked reservation even when the deployment was already ended', async () => {
    const job = jobAt(LifecycleJobPhase.RUNNING, JobType.Deprovision);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
    const deployment = {
      data: { reservationId: 'res-1', endDate: new Date() },
      endDeployment: vi.fn().mockReturnThis(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
      deployment as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>,
    );
    const endReservation = vi.spyOn(ReservationRecord, 'endActiveByIdUnscoped').mockResolvedValue(true);

    await service.applyJobCompleted(jobCompleted({ saga_name: 'deprovision' }));

    expect(deployment.endDeployment).not.toHaveBeenCalled();
    expect(deployment.save).not.toHaveBeenCalled();
    expect(deviceTokens.runWithDeploymentTokenRevocation).not.toHaveBeenCalled();
    expect(endReservation).toHaveBeenCalledWith('res-1', prismaTx);
  });

  it('lifecycle-only deprovision job.completed ends a rental that raced in mid-wipe', async () => {
    const job = LifecycleJobRecord.build({
      id: 'job-1',
      jobType: JobType.Deprovision,
      phase: LifecycleJobPhase.RUNNING,
      deviceId: 'device-1',
      deploymentId: null,
      organizationId: null,
      performedBy: 'user-1',
      source: RequestSource.API,
      payload: {},
    });
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue({
      id: 'dep-raced',
      customerId: 'org-raced',
    } as Awaited<ReturnType<typeof DeploymentRecord.findAggregateUnscoped>>);
    const deployment = {
      data: { reservationId: null, endDate: null },
      endDeployment: vi.fn().mockReturnThis(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
      deployment as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>,
    );

    await service.applyJobCompleted(jobCompleted({ saga_name: 'deprovision' }));

    expect(DeploymentRecord.findAggregateUnscoped).toHaveBeenCalledWith({
      where: { endDate: null, server: { deviceId: 'device-1' } },
    });
    expect(DeploymentRecord.findOneUnscoped).toHaveBeenCalledWith({
      where: { id: 'dep-raced', customerId: 'org-raced' },
    });
    expect(deviceTokens.runWithDeploymentTokenRevocation).toHaveBeenCalledWith(
      {
        deviceId: 'device-1',
        reason: DeviceTokenRevocationReason.DEPLOYMENT_ENDED,
        note: 'Deployment ended by deprovision job job-1 (completion converge)',
      },
      expect.any(Function),
    );
    expect(deployment.endDeployment).toHaveBeenCalled();
    expect(deployment.save).toHaveBeenCalledWith({ tx: prismaTx });
  });

  it('deprovision job.completed converges rental end even when the job already failed at dispatch', async () => {
    const job = jobAt(LifecycleJobPhase.FAILED, JobType.Deprovision);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
    const deployment = {
      data: { reservationId: 'res-1' },
      endDeployment: vi.fn().mockReturnThis(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
      deployment as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>,
    );
    const endReservation = vi.spyOn(ReservationRecord, 'endActiveByIdUnscoped').mockResolvedValue(true);

    await service.applyJobCompleted(jobCompleted({ saga_name: 'deprovision' }));

    expect(job.data.phase).toBe(LifecycleJobPhase.FAILED);
    expect(deployment.endDeployment).toHaveBeenCalled();
    expect(deployment.save).toHaveBeenCalledWith({ tx: prismaTx });
    expect(endReservation).toHaveBeenCalledWith('res-1', prismaTx);
    expect(eventBus.emit).not.toHaveBeenCalledWith('deprovision.completed', expect.anything());
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('deprovision job.completed stays completed when the rental-end convergence fails', async () => {
    const job = jobAt(LifecycleJobPhase.RUNNING, JobType.Deprovision);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);
    const deployment = {
      data: { reservationId: 'res-1', endDate: new Date() },
      endDeployment: vi.fn().mockReturnThis(),
      save: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(DeploymentRecord, 'findOneUnscoped').mockResolvedValue(
      deployment as unknown as Awaited<ReturnType<typeof DeploymentRecord.findOneUnscoped>>,
    );
    vi.spyOn(ReservationRecord, 'endActiveByIdUnscoped').mockRejectedValue(new Error('db down'));

    await expect(service.applyJobCompleted(jobCompleted({ saga_name: 'deprovision' }))).resolves.not.toThrow();

    expect(job.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(eventBus.emit).toHaveBeenCalledWith('deprovision.completed', expect.objectContaining({ jobId: 'job-1' }));
  });

  it('job_failed for a rewound interruptible deprovision fails it and clears the interruption marker', async () => {
    const job = LifecycleJobRecord.build({
      id: 'job-1',
      jobType: JobType.Deprovision,
      phase: LifecycleJobPhase.SCHEDULED,
      deviceId: 'device-1',
      deploymentId: 'dep-1',
      organizationId: 'org-1',
      performedBy: 'user-1',
      source: RequestSource.API,
      payload: {},
      scheduledAt: new Date(),
    });
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyStepResult(
      stepResult({ action_type: 'deprovision', event_type: 'job_failed', status: 'failed' }),
    );

    expect(job.data.phase).toBe(LifecycleJobPhase.FAILED);
    expect(DeploymentRecord.clearScheduledInterruption).toHaveBeenCalledWith('dep-1', 'org-1');
  });

  it('ignores a job.completed for a job still REQUESTED (result precedes dispatch)', async () => {
    const job = jobAt(LifecycleJobPhase.REQUESTED);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyJobCompleted(jobCompleted());

    expect(job.data.phase).toBe(LifecycleJobPhase.REQUESTED);
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('checkPhoneHomeDeadline fails a job still AWAITING_PHONE_HOME and emits provision.failed', async () => {
    const job = jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.checkPhoneHomeDeadline('job-1');

    expect(job.data.phase).toBe(LifecycleJobPhase.FAILED);
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: {
        lastJobId: 'job-1',
        server: {
          upsert: {
            create: { lifecycleStatus: ServerLifecycleStatus.FAILED },
            update: { lifecycleStatus: ServerLifecycleStatus.FAILED },
          },
        },
      },
    });
    expect(eventBus.emit).toHaveBeenCalledWith(
      'provision.failed',
      expect.objectContaining({ jobId: 'job-1', error: 'phone-home deadline exceeded' }),
    );
  });

  it('checkPhoneHomeDeadline completes (not fails) an AWAITING job whose server is already PROVISIONED', async () => {
    prisma.server.findUnique.mockResolvedValueOnce({ lifecycleStatus: ServerLifecycleStatus.PROVISIONED });
    const job = jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.checkPhoneHomeDeadline('job-1');

    expect(job.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith('provision.completed', expect.objectContaining({ jobId: 'job-1' }));
    expect(eventBus.emit).not.toHaveBeenCalledWith('provision.failed', expect.anything());
  });

  it('checkPhoneHomeDeadline is a no-op once the job has left AWAITING_PHONE_HOME', async () => {
    const job = jobAt(LifecycleJobPhase.COMPLETED);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.checkPhoneHomeDeadline('job-1');

    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('checkPowerSagaDeadline fails a still-DISPATCHED power job and clears the transitional power status', async () => {
    const job = jobAt(LifecycleJobPhase.DISPATCHED, JobType.PowerOff);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.checkPowerSagaDeadline('job-1');

    expect(job.data.phase).toBe(LifecycleJobPhase.FAILED);
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: 'device-1' },
      data: {
        lastJobId: 'job-1',
        server: {
          upsert: {
            create: { powerStatus: null },
            update: { powerStatus: null },
          },
        },
      },
    });
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('checkPowerSagaDeadline is a no-op once the power job has resolved', async () => {
    const job = jobAt(LifecycleJobPhase.COMPLETED, JobType.Reboot);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.checkPowerSagaDeadline('job-1');

    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('phone-home completes an AWAITING_PHONE_HOME provision and emits provision.completed', async () => {
    const job = jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME);
    vi.spyOn(LifecycleJobRecord, 'findOneUnscoped').mockResolvedValue(job);

    await service.applyPhoneHome('device-1');

    expect(job.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(eventBus.emit).toHaveBeenCalledWith('provision.completed', expect.objectContaining({ jobId: 'job-1' }));
  });

  it('phone-home racing the watchdog terminalizes once: only the CAS winner emits/side-effects', async () => {
    const phoneHomeJob = jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME);
    const watchdogJob = jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME);
    vi.spyOn(LifecycleJobRecord, 'findOneUnscoped').mockResolvedValue(phoneHomeJob);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(watchdogJob);

    const claim = vi
      .spyOn(LifecycleJobRecord, 'claimTransition')
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await service.applyPhoneHome('device-1');
    await service.checkPhoneHomeDeadline('job-1');

    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim).toHaveBeenNthCalledWith(
      1,
      'job-1',
      LifecycleJobPhase.AWAITING_PHONE_HOME,
      LifecycleJobPhase.COMPLETED,
      undefined,
    );
    expect(claim).toHaveBeenNthCalledWith(
      2,
      'job-1',
      LifecycleJobPhase.AWAITING_PHONE_HOME,
      LifecycleJobPhase.FAILED,
      'phone-home deadline exceeded',
    );

    expect(phoneHomeJob.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(watchdogJob.data.phase).toBe(LifecycleJobPhase.AWAITING_PHONE_HOME);

    expect(eventBus.emit).toHaveBeenCalledTimes(1);
    expect(eventBus.emit).toHaveBeenCalledWith('provision.completed', expect.objectContaining({ jobId: 'job-1' }));
    expect(eventBus.emit).not.toHaveBeenCalledWith('provision.failed', expect.anything());

    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('tolerates a missing LifecycleJob (legacy/autonomous flow)', async () => {
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(null);
    await expect(service.applyStepResult(stepResult())).resolves.toBe(false);
    expect(appendEvent).not.toHaveBeenCalled();
  });

  it('ignores a transition for an already-terminal job', async () => {
    const job = jobAt(LifecycleJobPhase.COMPLETED);
    vi.spyOn(LifecycleJobRecord, 'findByIdUnscoped').mockResolvedValue(job);

    await service.applyJobCompleted(jobCompleted({ status: 'failed', error: { message: 'late' } }));

    expect(job.data.phase).toBe(LifecycleJobPhase.COMPLETED);
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });
});
