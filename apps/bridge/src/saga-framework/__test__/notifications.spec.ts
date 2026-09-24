import { describe, expect, it, vi, type Mock } from 'vitest';

import {
  LOCK_WAIT_STEP_NAME,
  NotificationDeliveryError,
  NotificationsService,
  ResultsQueueProducer,
  classifyEventType,
  type EventType,
} from '../notifications.service';
import { JobStatus } from '../state.types';

interface EnqueueResultCall {
  planId: string;
  stepName: string;
  operation: string | null;
  status: string;
  deviceId: unknown;
  eventType: EventType;
  actionType: string;
  result?: unknown;
  error?: string | null;
  attempt: number;
  metadata: Record<string, unknown>;
}

interface EnqueueJobCompletedCall {
  planId: string;
  deviceId: unknown;
  sagaName: string;
  status: string;
  error?: string | null;
  metadata: Record<string, unknown>;
}

function makeProducer(): {
  producer: ResultsQueueProducer;
  enqueueResult: Mock<(...args: any[]) => any>;
  enqueueJobCompleted: Mock<(...args: any[]) => any>;
} {
  const enqueueResult = vi.fn(async (_args: EnqueueResultCall) => true);
  const enqueueJobCompleted = vi.fn(async (_args: EnqueueJobCompletedCall) => true);
  return {
    producer: { enqueueResult, enqueueJobCompleted },
    enqueueResult,
    enqueueJobCompleted,
  };
}

describe('NotificationsService', () => {
  it('enqueues a stage_changed result for a step COMPLETED transition', async () => {
    const { producer, enqueueResult, enqueueJobCompleted } = makeProducer();
    const svc = new NotificationsService(producer);

    await svc.notifyStepTransition({
      planId: 'plan-1',
      stepName: 'deploy_os',
      operation: 'Deploy the operating system',
      status: JobStatus.COMPLETED,
      deviceId: 42,
      result: { ok: true },
      metadata: { saga_name: 'provision' },
    });

    expect(enqueueJobCompleted).not.toHaveBeenCalled();
    expect(enqueueResult).toHaveBeenCalledTimes(1);
    const call = enqueueResult.mock.calls[0][0] as EnqueueResultCall;
    expect(call.planId).toBe('plan-1');
    expect(call.stepName).toBe('deploy_os');
    expect(call.operation).toBe('Deploy the operating system');
    expect(call.status).toBe(JobStatus.COMPLETED);
    expect(call.eventType).toBe('stage_changed');
    expect(call.actionType).toBe('provision');
    expect(call.result).toEqual({ ok: true });
  });

  it('defaults operation to null when the transition carries none', async () => {
    const { producer, enqueueResult } = makeProducer();
    const svc = new NotificationsService(producer);

    await svc.notifyStepTransition({
      planId: 'plan-1',
      stepName: 'deploy_os',
      status: JobStatus.COMPLETED,
      deviceId: 42,
      metadata: { saga_name: 'provision' },
    });

    expect(enqueueResult).toHaveBeenCalledWith(expect.objectContaining({ operation: null }));
  });

  it('enqueues job_completed for a plan-level __plan__ COMPLETED', async () => {
    const { producer, enqueueResult, enqueueJobCompleted } = makeProducer();
    const svc = new NotificationsService(producer);

    await svc.notifyStepTransition({
      planId: 'plan-done',
      stepName: '__plan__',
      status: JobStatus.COMPLETED,
      deviceId: 42,
      metadata: { saga_name: 'provision' },
    });

    expect(enqueueResult).not.toHaveBeenCalled();
    expect(enqueueJobCompleted).toHaveBeenCalledTimes(1);
    const call = enqueueJobCompleted.mock.calls[0][0] as EnqueueJobCompletedCall;
    expect(call.planId).toBe('plan-done');
    expect(call.sagaName).toBe('provision');
    expect(call.status).toBe(JobStatus.COMPLETED);
  });

  it('uses planId directly on the wire (no synthesis)', async () => {
    const { producer, enqueueResult } = makeProducer();
    const svc = new NotificationsService(producer);

    await svc.notifyStepTransition({
      planId: 'plan-1',
      stepName: 'deploy_os',
      status: JobStatus.RUNNING,
      deviceId: 42,
      metadata: { saga_name: 'provision' },
    });

    const call = enqueueResult.mock.calls[0][0] as EnqueueResultCall;
    expect(call.planId).toBe('plan-1');
  });

  it('classifies FAILED transitions as job_failed and forwards the error', async () => {
    const { producer, enqueueResult } = makeProducer();
    const svc = new NotificationsService(producer);

    await svc.notifyStepTransition({
      planId: 'plan-fail',
      stepName: 'wipe_disks',
      status: JobStatus.FAILED,
      deviceId: 42,
      error: 'disk not found',
      metadata: { saga_name: 'provision' },
    });

    const call = enqueueResult.mock.calls[0][0] as EnqueueResultCall;
    expect(call.eventType).toBe('job_failed');
    expect(call.error).toBe('disk not found');
  });

  it('enqueues blocked lock-wait context as job_blocked', async () => {
    const { producer, enqueueResult, enqueueJobCompleted } = makeProducer();
    const svc = new NotificationsService(producer);
    const lockWait = {
      lock_key: 'device:42',
      first_blocked_at: 100,
      attempts: 3,
      holder_plan_id: 'plan-holder',
    };

    await svc.notifyStepTransition({
      planId: 'plan-blocked',
      stepName: LOCK_WAIT_STEP_NAME,
      status: JobStatus.BLOCKED,
      deviceId: 42,
      result: { lock_wait: lockWait },
      metadata: { saga_name: 'provision' },
    });

    expect(enqueueJobCompleted).not.toHaveBeenCalled();
    expect(enqueueResult).toHaveBeenCalledTimes(1);
    const call = enqueueResult.mock.calls[0][0] as EnqueueResultCall;
    expect(call).toMatchObject({
      planId: 'plan-blocked',
      stepName: 'lock_wait',
      status: JobStatus.BLOCKED,
      deviceId: 42,
      eventType: 'job_blocked',
      actionType: 'provision',
      result: { lock_wait: lockWait },
      metadata: { saga_name: 'provision' },
    });
  });

  it('surfaces producer throws as NotificationDeliveryError instead of swallowing them', async () => {
    const enqueueResult = vi.fn(async () => {
      throw new Error('Redis down');
    });
    const enqueueJobCompleted = vi.fn(async () => true);
    const producer: ResultsQueueProducer = { enqueueResult, enqueueJobCompleted };
    const warns: string[] = [];
    const svc = new NotificationsService(producer, {
      info: () => undefined,
      warn: (msg) => warns.push(msg),
      error: () => undefined,
    });

    await expect(
      svc.notifyStepTransition({
        planId: 'plan-1',
        stepName: 'deploy_os',
        status: JobStatus.RUNNING,
        deviceId: 42,
        metadata: { saga_name: 'provision' },
      }),
    ).rejects.toBeInstanceOf(NotificationDeliveryError);
    expect(warns.some((m) => m.includes('Redis down'))).toBe(true);
  });

  it('surfaces a false producer return as NotificationDeliveryError', async () => {
    const enqueueResult = vi.fn(async () => false);
    const enqueueJobCompleted = vi.fn(async () => true);
    const producer: ResultsQueueProducer = { enqueueResult, enqueueJobCompleted };
    const warns: string[] = [];
    const svc = new NotificationsService(producer, {
      info: () => undefined,
      warn: (msg) => warns.push(msg),
      error: () => undefined,
    });

    await expect(
      svc.notifyStepTransition({
        planId: 'plan-1',
        stepName: 'deploy_os',
        status: JobStatus.RUNNING,
        deviceId: 42,
        metadata: { saga_name: 'provision' },
      }),
    ).rejects.toBeInstanceOf(NotificationDeliveryError);
    expect(warns).toEqual([expect.stringContaining('rejected notification')]);
  });

  it('surfaces a false enqueueJobCompleted return as NotificationDeliveryError', async () => {
    const enqueueResult = vi.fn(async () => true);
    const enqueueJobCompleted = vi.fn(async () => false);
    const producer: ResultsQueueProducer = { enqueueResult, enqueueJobCompleted };
    const warns: string[] = [];
    const svc = new NotificationsService(producer, {
      info: () => undefined,
      warn: (msg) => warns.push(msg),
      error: () => undefined,
    });

    await expect(
      svc.notifyStepTransition({
        planId: 'plan-done',
        stepName: '__plan__',
        status: JobStatus.COMPLETED,
        deviceId: 42,
        metadata: { saga_name: 'provision' },
      }),
    ).rejects.toBeInstanceOf(NotificationDeliveryError);
    expect(warns).toEqual([expect.stringContaining('rejected notification')]);
  });

  it('rejects when metadata carries no saga_name', async () => {
    const { producer, enqueueResult, enqueueJobCompleted } = makeProducer();
    const svc = new NotificationsService(producer);

    await expect(
      svc.notifyStepTransition({
        planId: 'plan-unlabeled',
        stepName: 'deploy_os',
        status: JobStatus.RUNNING,
        deviceId: 42,
        metadata: {},
      }),
    ).rejects.toThrow(/saga_name.*plan-unlabeled.*deploy_os/);
    await expect(
      svc.notifyStepTransition({
        planId: 'plan-unlabeled',
        stepName: 'deploy_os',
        status: JobStatus.RUNNING,
        deviceId: 42,
        metadata: { saga_name: '' },
      }),
    ).rejects.toThrow(/saga_name/);
    expect(enqueueResult).not.toHaveBeenCalled();
    expect(enqueueJobCompleted).not.toHaveBeenCalled();
  });

  it('forwards metadata.saga_name as the actionType', async () => {
    const { producer, enqueueResult } = makeProducer();
    const svc = new NotificationsService(producer);

    await svc.notifyStepTransition({
      planId: 'plan-collect',
      stepName: 'collect_inventory',
      status: JobStatus.RUNNING,
      deviceId: 42,
      metadata: { saga_name: 'inventory_collection' },
    });

    expect(enqueueResult).toHaveBeenCalledWith(expect.objectContaining({ actionType: 'inventory_collection' }));
  });

  it('forwards metadata.saga_name as the sagaName for job_completed events', async () => {
    const { producer, enqueueJobCompleted } = makeProducer();
    const svc = new NotificationsService(producer);

    await svc.notifyStepTransition({
      planId: 'plan-collect',
      stepName: '__plan__',
      status: JobStatus.COMPLETED,
      deviceId: 42,
      metadata: { saga_name: 'inventory_collection' },
    });

    expect(enqueueJobCompleted).toHaveBeenCalledWith(expect.objectContaining({ sagaName: 'inventory_collection' }));
  });

  it('with no producer wired, throws NotificationDeliveryError', async () => {
    const warns: string[] = [];
    const svc = new NotificationsService(null, {
      info: () => undefined,
      warn: (msg) => warns.push(msg),
      error: () => undefined,
    });

    await expect(
      svc.notifyStepTransition({
        planId: 'plan-x',
        stepName: 'deploy_os',
        status: JobStatus.RUNNING,
        deviceId: 42,
        metadata: { saga_name: 'provision' },
      }),
    ).rejects.toBeInstanceOf(NotificationDeliveryError);
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('producer unavailable');
  });
});

describe('classifyEventType', () => {
  it('returns job_blocked only for blocked lock_wait transitions', () => {
    expect(classifyEventType(JobStatus.BLOCKED, LOCK_WAIT_STEP_NAME)).toBe('job_blocked');
    expect(classifyEventType(JobStatus.BLOCKED, 'deploy_os')).toBe('stage_changed');
    expect(classifyEventType('blocked', LOCK_WAIT_STEP_NAME)).toBe('job_blocked');
    expect(classifyEventType('blocked', 'deploy_os')).toBe('stage_changed');
    expect(classifyEventType(JobStatus.RUNNING, LOCK_WAIT_STEP_NAME)).toBe('stage_changed');
  });

  it('returns job_failed for any FAILED status, regardless of stepName', () => {
    expect(classifyEventType(JobStatus.FAILED, 'deploy_os')).toBe('job_failed');
    expect(classifyEventType(JobStatus.FAILED, '__plan__')).toBe('job_failed');
  });

  it('returns job_completed only for COMPLETED on __plan__', () => {
    expect(classifyEventType(JobStatus.COMPLETED, '__plan__')).toBe('job_completed');
    expect(classifyEventType(JobStatus.COMPLETED, 'deploy_os')).toBe('stage_changed');
  });

  it('returns stage_changed for non-terminal step transitions', () => {
    expect(classifyEventType(JobStatus.RUNNING, 'deploy_os')).toBe('stage_changed');
    expect(classifyEventType(JobStatus.PENDING, 'deploy_os')).toBe('stage_changed');
  });
});
