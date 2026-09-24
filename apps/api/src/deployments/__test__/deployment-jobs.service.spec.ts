import { NotFoundException } from '@nestjs/common';
import {
  JobType,
  LifecycleJobPhase,
  RequestSource,
  type LifecycleJob,
  type LifecycleJobEvent,
} from '@repo/database';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeploymentRecord } from '../deployment.record';
import { DeploymentJobsService } from '../services/deployment-jobs.service';
import { createMockDeploymentAggregate } from './fixtures';

const JOB = '44444444-4444-4444-4444-444444444444';
const aggregate = createMockDeploymentAggregate();
const query = { page: 1, pageSize: 20 };

const jobRow = (overrides: Partial<LifecycleJob> = {}): LifecycleJob => ({
  id: JOB,
  jobType: JobType.Provision,
  phase: LifecycleJobPhase.FAILED,
  payload: {},
  deviceId: aggregate.server.deviceId,
  deploymentId: aggregate.id,
  organizationId: 'org-1',
  source: RequestSource.UI,
  performedBy: 'user-1',
  scheduledAt: null,
  phoneHomeDeadline: null,
  linkedJobId: null,
  error: 'Brokkr Live OS did not become ready',
  createdAt: new Date('2026-09-18T15:25:28.000Z'),
  updatedAt: new Date('2026-09-18T15:31:02.000Z'),
  ...overrides,
});

const eventRow = (overrides: Partial<LifecycleJobEvent> = {}): LifecycleJobEvent => ({
  id: 'e-1',
  jobId: JOB,
  sagaName: 'provision',
  stepName: 'wipe_disks',
  operation: 'Wipe all disks',
  eventType: 'step_failed',
  status: 'failed',
  result: { sanitization_report: { disks: [{ wwn: '0x5000' }] } },
  error: 'IPMI ping failed - IP 10.40.0.17 is not reachable',
  attempt: 1,
  occurredAt: new Date('2026-09-18T15:26:10.000Z'),
  recordedAt: new Date('2026-09-18T15:26:11.000Z'),
  ...overrides,
});

function setup(pinned = true) {
  vi.spyOn(DeploymentRecord, 'findActiveById').mockResolvedValue(pinned ? DeploymentRecord.fromRow(aggregate) : null);
  const findPage = vi.spyOn(LifecycleJobRecord, 'findPageByTargetUnscoped');
  const findOne = vi.spyOn(LifecycleJobRecord, 'findOneUnscoped');
  const listEvents = vi.spyOn(LifecycleJobRecord, 'listEventsUnscoped');
  return { service: new DeploymentJobsService(), findPage, findOne, listEvents };
}

afterEach(() => vi.restoreAllMocks());

describe('DeploymentJobsService.list', () => {
  it('404s before any job read when the pin finds no deployment', async () => {
    const { service, findPage } = setup(false);

    await expect(service.list(aggregate.id, query)).rejects.toBeInstanceOf(NotFoundException);

    expect(findPage).not.toHaveBeenCalled();
  });

  it('pages the deployment jobs through the customer presenter', async () => {
    const { service, findPage } = setup();
    findPage.mockResolvedValue({ data: [jobRow()], meta: { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 } });

    const page = await service.list(aggregate.id, query);

    expect(findPage).toHaveBeenCalledWith(query, { deploymentId: aggregate.id });
    expect(page.meta).toEqual({ page: 1, pageSize: 20, totalItems: 1, totalPages: 1 });
    expect(page.data).toEqual([
      {
        id: JOB,
        jobType: JobType.Provision,
        phase: LifecycleJobPhase.FAILED,
        deviceId: aggregate.server.deviceId,
        deploymentId: aggregate.id,
        source: RequestSource.UI,
        performedBy: null,
        error: null,
        createdAt: '2026-09-18T15:25:28.000Z',
        completedAt: '2026-09-18T15:31:02.000Z',
      },
    ]);
  });
});

describe('DeploymentJobsService.events', () => {
  it('404s before any job read when the pin finds no deployment', async () => {
    const { service, findOne, listEvents } = setup(false);

    await expect(service.events(aggregate.id, JOB)).rejects.toBeInstanceOf(NotFoundException);

    expect(findOne).not.toHaveBeenCalled();
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('404s a job recorded against another deployment', async () => {
    const { service, findOne, listEvents } = setup();
    findOne.mockResolvedValue(null);

    await expect(service.events(aggregate.id, JOB)).rejects.toBeInstanceOf(NotFoundException);

    expect(findOne).toHaveBeenCalledWith({ where: { id: JOB, deploymentId: aggregate.id } });
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('serves the capped events with every result and error nulled', async () => {
    const { service, findOne, listEvents } = setup();
    findOne.mockResolvedValue(LifecycleJobRecord.fromRow(jobRow()));
    listEvents.mockResolvedValue([
      eventRow(),
      eventRow({ id: 'e-2', stepName: 'phone_home', eventType: 'phone_home', status: 'complete', attempt: 0 }),
    ]);

    const out = await service.events(aggregate.id, JOB);

    expect(listEvents).toHaveBeenCalledWith(JOB, 501);
    expect(out.meta).toEqual({ truncated: false, cap: 500 });
    expect(out.data).toEqual([
      {
        id: 'e-1',
        sagaName: 'provision',
        stepName: 'wipe_disks',
        operation: 'Wipe all disks',
        eventType: 'step_failed',
        status: 'failed',
        result: null,
        error: null,
        attempt: 1,
        occurredAt: '2026-09-18T15:26:10.000Z',
        recordedAt: '2026-09-18T15:26:11.000Z',
        origin: 'bridge',
      },
      {
        id: 'e-2',
        sagaName: 'provision',
        stepName: 'phone_home',
        operation: 'Wipe all disks',
        eventType: 'phone_home',
        status: 'complete',
        result: null,
        error: null,
        attempt: 0,
        occurredAt: '2026-09-18T15:26:10.000Z',
        recordedAt: '2026-09-18T15:26:11.000Z',
        origin: 'hub',
      },
    ]);
  });
});
