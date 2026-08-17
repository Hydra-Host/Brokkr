import { PLUGIN_EVENT_BUS, type BrokkrEventMap } from '@hydrahost/plugin-sdk';
import { Test } from '@nestjs/testing';
import { DeploymentLifecycleActionType, JobType, RequestSource } from '@repo/database';
import { DeploymentRecord } from 'src/deployments/deployment.record';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeploymentLifecycleActionObserver } from '../observers/deployment-lifecycle-action.observer';

type DispatchedEvent = BrokkrEventMap['lifecycle.dispatched'];

describe('DeploymentLifecycleActionObserver', () => {
  let handler!: (e: DispatchedEvent) => unknown;
  const eventBus = {
    emit: vi.fn(),
    off: vi.fn(),
    on: vi.fn((_event: string, h: (e: DispatchedEvent) => unknown) => {
      handler = h;
      return () => {};
    }),
  };

  const baseEvent: DispatchedEvent = {
    jobId: 'job-1',
    jobType: JobType.Reboot,
    deviceId: 'device-1',
    deploymentId: null,
    organizationId: 'org-1',
    source: RequestSource.API,
    performedBy: 'user-1',
  };

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [DeploymentLifecycleActionObserver, { provide: PLUGIN_EVENT_BUS, useValue: eventBus }],
    }).compile();
    moduleRef.get(DeploymentLifecycleActionObserver).onModuleInit();
  });

  it('writes the action directly for the event deploymentId without a lookup (e.g. deprovision)', async () => {
    const findSpy = vi.spyOn(DeploymentRecord, 'findAggregateUnscoped');
    const createSpy = vi.spyOn(DeploymentRecord, 'createLifecycleAction').mockResolvedValue(undefined as never);

    await handler({ ...baseEvent, jobType: JobType.Deprovision, deploymentId: 'dep-99' });

    expect(findSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith({
      deploymentId: 'dep-99',
      actionType: DeploymentLifecycleActionType.Deprovision,
      source: RequestSource.API,
      performedBy: 'user-1',
    });
  });

  it('writes a lifecycle action for the active deployment of a mapped job type', async () => {
    const findSpy = vi
      .spyOn(DeploymentRecord, 'findAggregateUnscoped')
      .mockResolvedValue({ id: 'dep-1' } as Awaited<ReturnType<typeof DeploymentRecord.findAggregateUnscoped>>);
    const createSpy = vi.spyOn(DeploymentRecord, 'createLifecycleAction').mockResolvedValue(undefined as never);

    await handler(baseEvent);

    expect(findSpy).toHaveBeenCalledWith({
      where: { endDate: null, server: { deviceId: 'device-1' }, customerId: 'org-1' },
    });
    expect(createSpy).toHaveBeenCalledWith({
      deploymentId: 'dep-1',
      actionType: DeploymentLifecycleActionType.Reboot,
      source: RequestSource.API,
      performedBy: 'user-1',
    });
  });

  it('skips when there is no active deployment', async () => {
    vi.spyOn(DeploymentRecord, 'findAggregateUnscoped').mockResolvedValue(null);
    const createSpy = vi.spyOn(DeploymentRecord, 'createLifecycleAction');
    await handler(baseEvent);
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('skips (no deployment lookup) when organizationId is null', async () => {
    const findSpy = vi.spyOn(DeploymentRecord, 'findAggregateUnscoped');
    await handler({ ...baseEvent, organizationId: null });
    expect(findSpy).not.toHaveBeenCalled();
  });

  it('skips job types without a deployment-facing action (Commission)', async () => {
    const findSpy = vi.spyOn(DeploymentRecord, 'findAggregateUnscoped');
    await handler({ ...baseEvent, jobType: JobType.Commission });
    expect(findSpy).not.toHaveBeenCalled();
  });
});
