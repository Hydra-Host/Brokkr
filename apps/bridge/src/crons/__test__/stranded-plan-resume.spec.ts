import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const leader = vi.hoisted(() => ({ value: false }));

vi.mock('../../leader-election/leader-election.service.js', () => ({
  getLeaderService: () => ({ isLeader: leader.value }),
}));

import { resetBullmqConfigForTests } from '../../bullmq/bullmq.config.js';
import { BullmqQueueService } from '../../bullmq/queue.service.js';
import { PlanManagerService } from '../../saga-framework/plan-manager.service.js';
import type { CronSpec } from '../cron-base.js';
import { allSpecs, resetForTests } from '../cron-registry.js';
import { registerStrandedPlanResumeCron } from '../stranded-plan-resume.cron.js';

function planManager(): PlanManagerService {
  return new PlanManagerService(
    { redisKeyPrefix: 'bridge:jobs', defaultJobTtlSeconds: 7200 },
    {
      get: async () => null,
      set: async () => 'OK',
      scan: async () => [],
    },
    { info: () => {}, warn: () => {}, error: () => {} },
  );
}

function registeredSpec(): CronSpec {
  const spec = allSpecs().find((entry) => entry.name === 'stranded_plan_resume');
  if (spec === undefined) throw new Error('stranded plan resume cron was not registered');
  return spec;
}

const PLANS = [
  {
    planId: 'plan-1',
    sagaName: 'provision',
    payload: { device_id: 'device-1' },
    deviceId: 'device-1',
    jobId: 'hub-job-1',
  },
  {
    planId: 'plan-2',
    sagaName: 'deprovision',
    payload: { device_id: 'device-2' },
    deviceId: 'device-2',
    jobId: 'hub-job-2',
  },
];

beforeEach(() => {
  resetForTests();
  resetBullmqConfigForTests();
  leader.value = false;
});

afterEach(() => {
  resetForTests();
  resetBullmqConfigForTests();
  vi.restoreAllMocks();
});

describe('stranded plan resume cron', () => {
  it('does not run when this bridge is not the leader', () => {
    const manager = planManager();
    const scan = vi.spyOn(manager, 'scanResumablePlans');
    registerStrandedPlanResumeCron(manager, new BullmqQueueService());
    expect(registeredSpec().enabledWhen?.()).toBe(false);
    expect(scan).not.toHaveBeenCalled();
  });

  it('runs when this bridge is the leader', () => {
    leader.value = true;
    registerStrandedPlanResumeCron(planManager(), new BullmqQueueService());
    expect(registeredSpec().enabledWhen?.()).toBe(true);
  });

  it('re-enqueues each absent job as bridge-local', async () => {
    leader.value = true;
    const manager = planManager();
    vi.spyOn(manager, 'scanResumablePlans').mockResolvedValue(PLANS);
    const queue = new BullmqQueueService();
    vi.spyOn(queue, 'jobExistsInQueue').mockResolvedValue(false);
    const enqueue = vi.spyOn(queue, 'enqueueSagaJob').mockResolvedValue(false);
    registerStrandedPlanResumeCron(manager, queue);
    await registeredSpec().run(new AbortController().signal);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenNthCalledWith(1, {
      planId: PLANS[0].planId,
      sagaName: PLANS[0].sagaName,
      payload: PLANS[0].payload,
      deviceId: PLANS[0].deviceId,
      bridgeLocal: true,
      removeExisting: true,
    });
    expect(queue.jobExistsInQueue).toHaveBeenNthCalledWith(1, 'hub-job-1', 'plan-1');
  });

  it('skips a job that is already queued', async () => {
    const manager = planManager();
    vi.spyOn(manager, 'scanResumablePlans').mockResolvedValue(PLANS);
    const queue = new BullmqQueueService();
    vi.spyOn(queue, 'jobExistsInQueue').mockResolvedValue(true);
    const enqueue = vi.spyOn(queue, 'enqueueSagaJob');
    registerStrandedPlanResumeCron(manager, queue);
    await registeredSpec().run(new AbortController().signal);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('passes the configured batch size to the scan', async () => {
    const manager = planManager();
    const scan = vi.spyOn(manager, 'scanResumablePlans').mockResolvedValue([]);
    registerStrandedPlanResumeCron(manager, new BullmqQueueService());
    await registeredSpec().run(new AbortController().signal);
    expect(scan).toHaveBeenCalledWith({
      graceSecs: 60,
      staleSecs: 1800,
      batchSize: 10,
    });
  });

  it('stops between plans when the signal aborts', async () => {
    const manager = planManager();
    vi.spyOn(manager, 'scanResumablePlans').mockResolvedValue(PLANS);
    const queue = new BullmqQueueService();
    const controller = new AbortController();
    const exists = vi.spyOn(queue, 'jobExistsInQueue').mockImplementation(async () => {
      controller.abort();
      return false;
    });
    const enqueue = vi.spyOn(queue, 'enqueueSagaJob');
    registerStrandedPlanResumeCron(manager, queue);
    await registeredSpec().run(controller.signal);
    expect(exists).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
