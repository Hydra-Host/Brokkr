import { PLUGIN_EVENT_BUS } from '@hydrahost/plugin-sdk';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { JobType, LifecycleJobPhase, RequestSource, ServerLifecycleStatus } from '@repo/database';
import { LIFECYCLE_WATCHDOG_QUEUE, LifecycleJobRecord } from '@repo/lifecycle';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import { RedisPubSubService } from 'src/events/redis-pubsub.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LifecycleInboundService, STUCK_SWEEP_PAGE_SIZE } from '../inbound/lifecycle-inbound.service';
import { LifecycleService } from '../lifecycle.service';

const MINUTES = 60 * 1000;
const HOURS = 60 * MINUTES;

function agoMs(ms: number): Date {
  return new Date(Date.now() - ms);
}

function jobAt(
  phase: LifecycleJobPhase,
  over: { id?: string; jobType?: JobType; deploymentId?: string | null } & Partial<
    Record<'updatedAt' | 'scheduledAt' | 'phoneHomeDeadline', Date | null>
  > = {},
): LifecycleJobRecord {
  return LifecycleJobRecord.build({
    id: 'job-1',
    jobType: JobType.Provision,
    phase,
    deviceId: 'device-1',
    deploymentId: 'dep-1',
    organizationId: 'org-1',
    performedBy: 'user-1',
    source: RequestSource.API,
    payload: {},
    scheduledAt: null,
    phoneHomeDeadline: null,
    updatedAt: new Date(),
    ...over,
  });
}

describe('LifecycleInboundService.sweepStuckJobs', () => {
  const eventBus = { emit: vi.fn(), on: vi.fn(), off: vi.fn() };
  const prisma = {
    device: { update: vi.fn().mockResolvedValue({}) },
    server: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    lifecycleJobEvent: { groupBy: vi.fn().mockResolvedValue([]) },
  };
  const watchdogQueue = { add: vi.fn().mockResolvedValue({ id: 'bull-1' }) };
  const lifecycleService = {
    startLinkedProvision: vi.fn().mockResolvedValue(undefined),
    abortLinkedProvision: vi.fn().mockResolvedValue(undefined),
  };

  let service: LifecycleInboundService;
  let appendEvent: ReturnType<typeof vi.spyOn>;
  let claim: ReturnType<typeof vi.spyOn>;
  let clearInterruption: ReturnType<typeof vi.spyOn>;

  function sweepCandidates(...jobs: LifecycleJobRecord[]) {
    vi.spyOn(LifecycleJobRecord, 'findManyUnscoped').mockResolvedValue(jobs);
  }

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    prisma.lifecycleJobEvent.groupBy.mockResolvedValue([]);
    appendEvent = vi.spyOn(LifecycleJobRecord, 'appendEvent').mockResolvedValue(undefined as never);
    claim = vi.spyOn(LifecycleJobRecord, 'claimTransition').mockResolvedValue(true);
    clearInterruption = vi.spyOn(DeploymentRecord, 'clearScheduledInterruption').mockResolvedValue(undefined);

    const moduleRef = await Test.createTestingModule({
      providers: [
        LifecycleInboundService,
        { provide: PLUGIN_EVENT_BUS, useValue: eventBus },
        { provide: PrismaClient, useValue: prisma },
        { provide: getQueueToken(LIFECYCLE_WATCHDOG_QUEUE), useValue: watchdogQueue },
        { provide: LifecycleService, useValue: lifecycleService },
        { provide: DeviceTokensService, useValue: { runWithDeploymentTokenRevocation: vi.fn() } },
        { provide: RedisPubSubService, useValue: { publish: vi.fn() } },
        {
          provide: 'LoggerServiceLifecycleInboundService',
          useValue: { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(LifecycleInboundService);
  });

  it('leaves jobs within their phase deadlines untouched', async () => {
    sweepCandidates(
      jobAt(LifecycleJobPhase.REQUESTED, { updatedAt: agoMs(1 * MINUTES) }),
      jobAt(LifecycleJobPhase.DISPATCHED, { updatedAt: agoMs(10 * MINUTES) }),
      jobAt(LifecycleJobPhase.RUNNING, { updatedAt: agoMs(1 * HOURS) }),
      jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME, { phoneHomeDeadline: new Date(Date.now() + 10 * MINUTES) }),
    );

    await expect(service.sweepStuckJobs()).resolves.toBe(0);
    expect(claim).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('fails a DISPATCHED job past its deadline: claim, audit, device FAILED, provision.failed', async () => {
    sweepCandidates(jobAt(LifecycleJobPhase.DISPATCHED, { updatedAt: agoMs(31 * MINUTES) }));

    await expect(service.sweepStuckJobs()).resolves.toBe(1);

    expect(claim).toHaveBeenCalledWith(
      'job-1',
      LifecycleJobPhase.DISPATCHED,
      LifecycleJobPhase.FAILED,
      'no bridge response after dispatch',
    );
    expect(appendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1', eventType: 'stuck_sweep', status: 'failed' }),
    );
    expect(prisma.device.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          server: {
            upsert: {
              create: { lifecycleStatus: ServerLifecycleStatus.FAILED },
              update: { lifecycleStatus: ServerLifecycleStatus.FAILED },
            },
          },
        }),
      }),
    );
    expect(eventBus.emit).toHaveBeenCalledWith(
      'provision.failed',
      expect.objectContaining({ jobId: 'job-1', error: 'no bridge response after dispatch' }),
    );
  });

  it('aborts a stuck REQUESTED provision and signals its orphaned deployment', async () => {
    sweepCandidates(jobAt(LifecycleJobPhase.REQUESTED, { updatedAt: agoMs(16 * MINUTES) }));

    await expect(service.sweepStuckJobs()).resolves.toBe(1);

    expect(claim).toHaveBeenCalledWith(
      'job-1',
      LifecycleJobPhase.REQUESTED,
      LifecycleJobPhase.ABORTED,
      expect.any(String),
    );
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).toHaveBeenCalledWith(
      'provision.failed',
      expect.objectContaining({ jobId: 'job-1', deploymentId: 'dep-1' }),
    );
  });

  it('aborts a stuck AUTHORIZING reboot silently (no deployment, nothing to signal)', async () => {
    sweepCandidates(
      jobAt(LifecycleJobPhase.AUTHORIZING, {
        jobType: JobType.Reboot,
        deploymentId: null,
        updatedAt: agoMs(16 * MINUTES),
      }),
    );

    await expect(service.sweepStuckJobs()).resolves.toBe(1);
    expect(claim).toHaveBeenCalledWith(
      'job-1',
      LifecycleJobPhase.AUTHORIZING,
      LifecycleJobPhase.ABORTED,
      expect.any(String),
    );
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('judges RUNNING by bridge activity, not just the phase write', async () => {
    sweepCandidates(jobAt(LifecycleJobPhase.RUNNING, { updatedAt: agoMs(3 * HOURS) }));
    prisma.lifecycleJobEvent.groupBy.mockResolvedValueOnce([
      { jobId: 'job-1', _max: { recordedAt: agoMs(10 * MINUTES) } },
    ]);
    await expect(service.sweepStuckJobs()).resolves.toBe(0);

    sweepCandidates(jobAt(LifecycleJobPhase.RUNNING, { updatedAt: agoMs(3 * HOURS) }));
    prisma.lifecycleJobEvent.groupBy.mockResolvedValueOnce([
      { jobId: 'job-1', _max: { recordedAt: agoMs(3 * HOURS) } },
    ]);
    await expect(service.sweepStuckJobs()).resolves.toBe(1);
    expect(claim).toHaveBeenCalledWith(
      'job-1',
      LifecycleJobPhase.RUNNING,
      LifecycleJobPhase.FAILED,
      'no bridge activity while running',
    );
  });

  it('aborts a SCHEDULED job whose resume never happened and clears the interruption marker', async () => {
    sweepCandidates(
      jobAt(LifecycleJobPhase.SCHEDULED, { jobType: JobType.Deprovision, scheduledAt: agoMs(31 * MINUTES) }),
    );

    await expect(service.sweepStuckJobs()).resolves.toBe(1);
    expect(claim).toHaveBeenCalledWith(
      'job-1',
      LifecycleJobPhase.SCHEDULED,
      LifecycleJobPhase.ABORTED,
      'grace timer never resumed the job',
    );
    expect(clearInterruption).toHaveBeenCalledWith('dep-1', 'org-1');
    expect(prisma.device.update).not.toHaveBeenCalled();
  });

  it('leaves a SCHEDULED job alone before its resume time, however old the row is', async () => {
    sweepCandidates(
      jobAt(LifecycleJobPhase.SCHEDULED, {
        jobType: JobType.Deprovision,
        updatedAt: agoMs(2 * HOURS),
        scheduledAt: new Date(Date.now() + 10 * MINUTES),
      }),
    );

    await expect(service.sweepStuckJobs()).resolves.toBe(0);
    expect(claim).not.toHaveBeenCalled();
    expect(clearInterruption).not.toHaveBeenCalled();
  });

  it('fails AWAITING_PHONE_HOME once the deadline plus sweep grace has passed', async () => {
    sweepCandidates(jobAt(LifecycleJobPhase.AWAITING_PHONE_HOME, { phoneHomeDeadline: agoMs(16 * MINUTES) }));

    await expect(service.sweepStuckJobs()).resolves.toBe(1);
    expect(claim).toHaveBeenCalledWith(
      'job-1',
      LifecycleJobPhase.AWAITING_PHONE_HOME,
      LifecycleJobPhase.FAILED,
      'phone-home deadline exceeded',
    );
    expect(eventBus.emit).toHaveBeenCalledWith('provision.failed', expect.objectContaining({ jobId: 'job-1' }));
  });

  it('writes nothing when the claim is lost to a racing writer', async () => {
    claim.mockResolvedValue(false);
    sweepCandidates(jobAt(LifecycleJobPhase.DISPATCHED, { updatedAt: agoMs(31 * MINUTES) }));

    await expect(service.sweepStuckJobs()).resolves.toBe(0);
    expect(appendEvent).not.toHaveBeenCalled();
    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(eventBus.emit).not.toHaveBeenCalled();
  });

  it('isolates per-job failures so one bad job cannot shield the rest', async () => {
    claim.mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce(true);
    sweepCandidates(
      jobAt(LifecycleJobPhase.DISPATCHED, { id: 'job-1', updatedAt: agoMs(31 * MINUTES) }),
      jobAt(LifecycleJobPhase.DISPATCHED, { id: 'job-2', updatedAt: agoMs(31 * MINUTES) }),
    );

    await expect(service.sweepStuckJobs()).resolves.toBe(1);
    expect(claim).toHaveBeenCalledTimes(2);
  });

  it('paginates the whole candidate set: a stuck job past the first page is still evaluated', async () => {
    const firstPage = Array.from({ length: STUCK_SWEEP_PAGE_SIZE }, (_, i) =>
      jobAt(LifecycleJobPhase.RUNNING, { id: `run-${i}`, updatedAt: new Date() }),
    );
    const stuckOnPageTwo = jobAt(LifecycleJobPhase.DISPATCHED, {
      id: 'stuck-dispatched',
      updatedAt: agoMs(31 * MINUTES),
    });
    const findMany = vi
      .spyOn(LifecycleJobRecord, 'findManyUnscoped')
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([stuckOnPageTwo]);

    await expect(service.sweepStuckJobs()).resolves.toBe(1);

    expect(findMany).toHaveBeenCalledTimes(2);
    const secondCallArgs = findMany.mock.calls[1][0] as { cursor?: { id: string } };
    expect(secondCallArgs.cursor).toEqual({ id: `run-${STUCK_SWEEP_PAGE_SIZE - 1}` });
    expect(claim).toHaveBeenCalledWith(
      'stuck-dispatched',
      LifecycleJobPhase.DISPATCHED,
      LifecycleJobPhase.FAILED,
      'no bridge response after dispatch',
    );
  });
});
