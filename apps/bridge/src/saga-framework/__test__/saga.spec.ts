import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentNotConnected, AgentNotResponsive } from '../../agent/dispatch/grpc.exceptions';
import { ShutdownRequested } from '../../common/async/shutdown-signal';
import { NotificationsService } from '../notifications.service';
import { PlanManagerService, rewindStepsFrom, transitionPlanStep } from '../plan-manager.service';
import type { LifecyclePlan, LifecyclePlanStep } from '../plan.types';
import { LockLost, NonRetryableSagaError, SagaRunnerService } from '../saga-runner.service';
import type { RecoveryAction, SagaContext, SagaDef, SagaStepDef } from '../saga.types';
import { JobStatus } from '../state.types';

function makeStep(name: string, overrides: Partial<LifecyclePlanStep> = {}): LifecyclePlanStep {
  return {
    step_name: name,
    operation: name,
    status: JobStatus.PENDING,
    created_at: 0,
    started_at: null,
    completed_at: null,
    error: null,
    result: null,
    job_id: null,
    queue_name: null,
    attempt: 0,
    ...overrides,
  };
}

function makePlan(steps: LifecyclePlanStep[], overrides: Partial<LifecyclePlan> = {}): LifecyclePlan {
  return {
    plan_id: 'test-plan',
    device_id: 42,
    job_class: 'lifecycle',
    status: JobStatus.PENDING,
    created_at: 0,
    started_at: null,
    completed_at: null,
    error: null,
    metadata: {},
    steps,
    ...overrides,
  };
}

function makeInMemoryPlanManager(initial: LifecyclePlan): {
  manager: PlanManagerService;
  plans: Map<string, LifecyclePlan>;
  rewindCalls: Array<{ planId: string; rewindTo: string; failedStep: string }>;
} {
  const plans = new Map<string, LifecyclePlan>();
  plans.set(initial.plan_id, initial);
  const rewindCalls: Array<{ planId: string; rewindTo: string; failedStep: string }> = [];

  const manager = {
    start: vi.fn(async () => undefined),
    getPlan: vi.fn(async (planId: string) => plans.get(planId) ?? null),
    updateStepStatus: vi.fn(
      async (args: {
        planId: string;
        stepName: string;
        status: JobStatus;
        error?: string | null;
        result?: unknown;
      }) => {
        const current = plans.get(args.planId);
        if (!current) return;
        plans.set(
          args.planId,
          transitionPlanStep(current, {
            stepName: args.stepName,
            status: args.status,
            error: args.error ?? null,
            result: (args.result ?? null) as LifecyclePlanStep['result'],
          }),
        );
      },
    ),
    rewindPlan: vi.fn(async (args: { planId: string; rewindTo: string; failedStep: string }) => {
      rewindCalls.push(args);
      const current = plans.get(args.planId);
      if (!current) return null;
      const rewound = rewindStepsFrom(current, {
        rewindTo: args.rewindTo,
        failedStep: args.failedStep,
      });
      plans.set(args.planId, rewound);
      return rewound;
    }),
  } as unknown as PlanManagerService;

  return { manager, plans, rewindCalls };
}

function makeRecordingNotifications(): {
  notifications: NotificationsService;
  calls: Array<{
    planId: string;
    stepName: string;
    operation: string | null;
    status: JobStatus;
    error?: string | null;
    result?: unknown;
    attempt?: number;
  }>;
} {
  const calls: Array<{
    planId: string;
    stepName: string;
    operation: string | null;
    status: JobStatus;
    error?: string | null;
    result?: unknown;
    attempt?: number;
  }> = [];
  const notifications = {
    notifyStepTransition: vi.fn(async (event) => {
      calls.push({
        planId: event.planId,
        stepName: event.stepName,
        operation: event.operation ?? null,
        status: event.status,
        error: event.error ?? null,
        result: event.result ?? null,
        attempt: event.attempt ?? 0,
      });
    }),
  } as unknown as NotificationsService;
  return { notifications, calls };
}

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const successStep = async (_ctx: SagaContext) => ({ ok: true });
const failingStep = async (_ctx: SagaContext): Promise<unknown> => {
  throw new Error('step failed');
};

function makeDeferred(): {
  promise: Promise<unknown>;
  resolve(value: unknown): void;
  reject(reason: unknown): void;
} {
  const controls = {
    resolve: (_value: unknown): void => undefined,
    reject: (_reason: unknown): void => undefined,
  };
  const promise = new Promise<unknown>((resolve, reject) => {
    controls.resolve = resolve;
    controls.reject = reject;
  });
  return {
    promise,
    resolve: (value) => controls.resolve(value),
    reject: (reason) => controls.reject(reason),
  };
}

class TestLockLostSignal {
  private fired = false;
  private resolveWait: (() => void) | null = null;
  disposeCalls = 0;
  private readonly waitPromise = new Promise<void>((resolve) => {
    this.resolveWait = resolve;
  });

  set(): void {
    this.fired = true;
    this.resolveWait?.();
    this.resolveWait = null;
  }

  isSet(): boolean {
    return this.fired;
  }

  wait(): Promise<void> {
    return this.waitPromise;
  }

  dispose(): void {
    this.disposeCalls += 1;
    this.resolveWait = null;
  }
}

function simpleSaga(): SagaDef {
  return {
    name: 'test',
    steps: [
      { name: 'step_a', operation: 'Step A', execute: successStep },
      { name: 'step_b', operation: 'Step B', execute: successStep },
    ],
  };
}

function sagaWithRecovery(execute: SagaStepDef['execute']): SagaDef {
  const recovery: RecoveryAction[] = [{ rewindTo: 'wipe', description: 'Re-wipe and retry' }];
  return {
    name: 'test-recovery',
    steps: [
      { name: 'wipe', operation: 'Wipe', execute: successStep },
      { name: 'install', operation: 'Install', execute, maxAttempts: 2, recovery },
    ],
  };
}

function sagaAllFail(): SagaDef {
  return sagaWithRecovery(failingStep);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SagaRunner — happy path', () => {
  it('runs each step to COMPLETED and fans out notifications', async () => {
    const initial = makePlan([makeStep('step_a'), makeStep('step_b')]);
    const { manager, plans } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    const result = await runner.execute(simpleSaga(), {
      planId: 'test-plan',
      payload: { device_id: 42 },
    });

    expect(result?.status).toBe(JobStatus.COMPLETED);
    expect(result?.steps[0].status).toBe(JobStatus.COMPLETED);
    expect(result?.steps[1].status).toBe(JobStatus.COMPLETED);
    expect(plans.get('test-plan')?.status).toBe(JobStatus.COMPLETED);

    expect(calls.length).toBeGreaterThanOrEqual(4);
    const statuses = calls.map((c) => c.status);
    expect(statuses).toContain(JobStatus.RUNNING);
    expect(statuses).toContain(JobStatus.COMPLETED);
  });

  it('emits a __plan__ COMPLETED at the end when the whole saga finishes', async () => {
    const initial = makePlan([makeStep('step_a'), makeStep('step_b')]);
    const { manager } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    await runner.execute(simpleSaga(), { planId: 'test-plan', payload: {} });

    const planFinal = calls.filter((c) => c.stepName === '__plan__' && c.status === JobStatus.COMPLETED);
    expect(planFinal.length).toBe(1);
  });

  it('notifies each step with its plan operation label and the __plan__ row with none', async () => {
    const initial = makePlan([
      makeStep('wipe_disks', { operation: 'Wipe all disks' }),
      makeStep('step_b', { operation: '' }),
    ]);
    const { manager } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    await runner.execute(
      {
        name: 'test',
        steps: [
          { name: 'wipe_disks', operation: 'Wipe all disks', execute: successStep },
          { name: 'step_b', execute: successStep },
        ],
      },
      { planId: 'test-plan', payload: {} },
    );

    const completed = (stepName: string) =>
      calls.find((c) => c.stepName === stepName && c.status === JobStatus.COMPLETED);
    expect(completed('wipe_disks')?.operation).toBe('Wipe all disks');
    expect(completed('step_b')?.operation).toBeNull();
    expect(completed('__plan__')?.operation).toBeNull();
  });
});

describe('SagaRunner — recovery & retry', () => {
  it('rewinds and retries when a step fails on the first attempt then succeeds', async () => {
    let calls = 0;
    const flakyStep = async (ctx: SagaContext) => {
      calls += 1;
      if (ctx.attempt === 0) throw new Error('transient failure');
      return { recovered: true };
    };

    const initial = makePlan([makeStep('wipe'), makeStep('install')]);
    const { manager, rewindCalls } = makeInMemoryPlanManager(initial);
    const { notifications } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    const result = await runner.execute(sagaWithRecovery(flakyStep), {
      planId: 'test-plan',
      payload: { device_id: 42 },
    });

    expect(result?.status).toBe(JobStatus.COMPLETED);
    const installStep = result?.steps.find((s) => s.step_name === 'install');
    expect(installStep?.status).toBe(JobStatus.COMPLETED);
    expect(installStep?.attempt).toBe(1);
    expect(rewindCalls).toEqual([{ planId: 'test-plan', rewindTo: 'wipe', failedStep: 'install' }]);
    expect(calls).toBe(2);
  });

  it('marks the plan FAILED once recovery retries are exhausted', async () => {
    const initial = makePlan([makeStep('wipe'), makeStep('install')]);
    const { manager } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    const result = await runner.execute(sagaAllFail(), {
      planId: 'test-plan',
      payload: { device_id: 42 },
    });

    expect(result?.status).toBe(JobStatus.FAILED);
    const planFailures = calls.filter((c) => c.stepName === '__plan__' && c.status === JobStatus.FAILED);
    expect(planFailures.length).toBe(1);
  });

  it('treats a left-over RUNNING step as a crash and recovers', async () => {
    let calls = 0;
    const flakyStep = async (ctx: SagaContext) => {
      calls += 1;
      if (ctx.attempt === 0) throw new Error('still flaky');
      return { recovered: true };
    };

    const initial = makePlan(
      [
        makeStep('wipe', { status: JobStatus.COMPLETED }),
        makeStep('install', { status: JobStatus.RUNNING, attempt: 0 }),
      ],
      { status: JobStatus.RUNNING },
    );
    const { manager } = makeInMemoryPlanManager(initial);
    const { notifications } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    const result = await runner.execute(sagaWithRecovery(flakyStep), {
      planId: 'test-plan',
      payload: { device_id: 42 },
    });

    expect(result?.status).toBe(JobStatus.COMPLETED);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

describe('SagaRunner — error handling', () => {
  it('short-circuits to FAILED on NonRetryableSagaError without rewinding', async () => {
    const nonRetryable = async (_ctx: SagaContext): Promise<unknown> => {
      throw new NonRetryableSagaError('frozen payload missing required field');
    };
    const recovery: RecoveryAction[] = [{ rewindTo: 'wipe', description: 'Re-wipe and retry' }];
    const saga: SagaDef = {
      name: 'non-retryable',
      steps: [
        { name: 'wipe', operation: 'Wipe', execute: successStep },
        {
          name: 'install',
          operation: 'Install',
          execute: nonRetryable,
          maxAttempts: 3,
          recovery,
        },
      ],
    };

    const initial = makePlan([makeStep('wipe'), makeStep('install')]);
    const { manager, rewindCalls } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    const result = await runner.execute(saga, {
      planId: 'test-plan',
      payload: { device_id: 42 },
    });

    expect(result?.status).toBe(JobStatus.FAILED);
    const install = result?.steps.find((s) => s.step_name === 'install');
    expect(install?.status).toBe(JobStatus.FAILED);
    expect(install?.attempt).toBe(0);
    expect(rewindCalls).toEqual([]);
    const planFailures = calls.filter((c) => c.stepName === '__plan__' && c.status === JobStatus.FAILED);
    expect(planFailures.length).toBe(1);
  });

  it('raises LockLost during an in-flight step and resets the step to PENDING', async () => {
    vi.useFakeTimers();
    let stepRuns = 0;
    let stepSignal: AbortSignal | undefined;
    let stepWorkId: string | undefined;
    const deferred = makeDeferred();
    const interruptedStep = async (ctx: SagaContext) => {
      stepRuns += 1;
      stepSignal = ctx.signal;
      stepWorkId = ctx.workId;
      return deferred.promise;
    };
    const saga: SagaDef = {
      name: 'lock-lost',
      steps: [{ name: 'step_a', operation: 'Step A', execute: interruptedStep }],
    };
    const initial = makePlan([makeStep('step_a')]);
    const { manager, plans } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);
    const lockLost = new TestLockLostSignal();

    const execution = runner.execute(saga, {
      planId: 'test-plan',
      payload: { device_id: 42 },
      lockLost,
    });
    const rejection = expect(execution).rejects.toBeInstanceOf(LockLost);
    await vi.advanceTimersByTimeAsync(0);
    expect(stepRuns).toBe(1);
    expect(stepWorkId).toBe('test-plan:step_a:0');

    lockLost.set();
    await vi.advanceTimersByTimeAsync(0);
    expect(stepSignal?.aborted).toBe(true);
    await rejection;
    deferred.resolve({ shouldNotPersist: true });
    await Promise.resolve();
    const saved = plans.get('test-plan');
    expect(saved?.steps[0].status).toBe(JobStatus.PENDING);
    expect(saved?.steps[0].result).toBeNull();
    expect(calls.some((call) => call.status === JobStatus.COMPLETED || call.status === JobStatus.FAILED)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start a step when the lock is already lost', async () => {
    const execute = vi.fn(async (_ctx: SagaContext): Promise<unknown> => ({ shouldNotPersist: true }));
    const saga: SagaDef = {
      name: 'pre-step-lock-loss',
      steps: [{ name: 'install', operation: 'Install', execute }],
    };
    const initial = makePlan([makeStep('install')]);
    const { manager, plans } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);
    const lockLost = new TestLockLostSignal();
    lockLost.set();

    await expect(
      runner.execute(saga, {
        planId: 'test-plan',
        payload: {},
        lockLost,
      }),
    ).rejects.toBeInstanceOf(LockLost);

    expect(execute).not.toHaveBeenCalled();
    expect(plans.get('test-plan')?.steps[0].status).toBe(JobStatus.PENDING);
    expect(plans.get('test-plan')?.steps[0].result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('disposes the lock signal after successful and failed execution', async () => {
    const lockLost = new TestLockLostSignal();

    {
      const initial = makePlan([makeStep('step_a'), makeStep('step_b')]);
      const { manager } = makeInMemoryPlanManager(initial);
      const { notifications } = makeRecordingNotifications();
      const runner = new SagaRunnerService(manager, notifications, silentLogger);

      await runner.execute(simpleSaga(), { planId: 'test-plan', payload: {}, lockLost });
      expect(lockLost.disposeCalls).toBe(1);
    }

    {
      const noAgent = async (_ctx: SagaContext): Promise<unknown> => {
        throw new AgentNotConnected('42');
      };
      const saga: SagaDef = {
        name: 'waiter-cleanup-failure',
        steps: [{ name: 'install', operation: 'Install', execute: noAgent }],
      };
      const initial = makePlan([makeStep('install')]);
      const { manager } = makeInMemoryPlanManager(initial);
      const { notifications } = makeRecordingNotifications();
      const runner = new SagaRunnerService(manager, notifications, silentLogger);

      await expect(runner.execute(saga, { planId: 'test-plan', payload: {}, lockLost })).rejects.toBeInstanceOf(
        AgentNotConnected,
      );
      expect(lockLost.disposeCalls).toBe(2);
    }
  });

  it('keeps completed steps completed and the next step pending when lock loss is found at the loop top', async () => {
    const stepRuns: string[] = [];
    const recordingStep = async (ctx: SagaContext) => {
      stepRuns.push(ctx.stepName);
      return { ok: true };
    };
    const saga: SagaDef = {
      name: 'lock-lost-between-steps',
      steps: [
        { name: 'step_a', operation: 'Step A', execute: recordingStep },
        { name: 'step_b', operation: 'Step B', execute: recordingStep },
      ],
    };
    const initial = makePlan([makeStep('step_a'), makeStep('step_b')]);
    const { manager, plans } = makeInMemoryPlanManager(initial);
    const { notifications } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);
    let checks = 0;
    const lockLost = {
      isSet: () => {
        checks += 1;
        return checks === 3;
      },
    };

    await expect(runner.execute(saga, { planId: 'test-plan', payload: {}, lockLost })).rejects.toBeInstanceOf(
      LockLost,
    );

    expect(stepRuns).toEqual(['step_a']);
    expect(plans.get('test-plan')?.steps.map((step) => step.status)).toEqual([
      JobStatus.COMPLETED,
      JobStatus.PENDING,
    ]);
  });

  it('reverts a generically failing step when lock loss occurs without changing recovery state or attempt', async () => {
    let lost = false;
    const interrupted = async (_ctx: SagaContext): Promise<unknown> => {
      lost = true;
      throw new Error('operation failed after lock loss');
    };
    const initial = makePlan(
      [
        makeStep('wipe', { status: JobStatus.COMPLETED }),
        makeStep('install', { attempt: 1 }),
      ],
      { metadata: { rewound: true } },
    );
    const { manager, plans, rewindCalls } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    await expect(
      runner.execute(sagaWithRecovery(interrupted), {
        planId: 'test-plan',
        payload: {},
        lockLost: { isSet: () => lost },
      }),
    ).rejects.toBeInstanceOf(LockLost);

    const saved = plans.get('test-plan');
    expect(saved?.steps[0].status).toBe(JobStatus.COMPLETED);
    expect(saved?.steps[1].status).toBe(JobStatus.PENDING);
    expect(saved?.steps[1].attempt).toBe(1);
    expect(saved?.metadata).toEqual({ rewound: true });
    expect(rewindCalls).toEqual([]);
    expect(calls.some((call) => call.status === JobStatus.FAILED)).toBe(false);
  });

  it.each([
    ['AgentNotConnected', () => new AgentNotConnected('42')],
    ['AgentNotResponsive', () => new AgentNotResponsive('42', 1)],
  ])('uses lock-loss handling when %s races with lock loss', async (_name, makeError) => {
    let lost = false;
    const interrupted = async (_ctx: SagaContext): Promise<unknown> => {
      lost = true;
      throw makeError();
    };
    const saga: SagaDef = {
      name: 'agent-lock-race',
      steps: [{ name: 'dispatch', operation: 'Dispatch', execute: interrupted }],
    };
    const initial = makePlan([makeStep('dispatch', { attempt: 2 })], {
      metadata: { rewound: true },
    });
    const { manager, plans, rewindCalls } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    await expect(
      runner.execute(saga, {
        planId: 'test-plan',
        payload: {},
        lockLost: { isSet: () => lost },
      }),
    ).rejects.toBeInstanceOf(LockLost);

    expect(plans.get('test-plan')?.steps[0].status).toBe(JobStatus.PENDING);
    expect(plans.get('test-plan')?.steps[0].attempt).toBe(2);
    expect(plans.get('test-plan')?.metadata).toEqual({ rewound: true });
    expect(rewindCalls).toEqual([]);
    expect(calls.some((call) => call.status === JobStatus.FAILED)).toBe(false);
  });

  it('reverts a successful step to PENDING when the lock is lost before completion is persisted', async () => {
    const lockLost = new TestLockLostSignal();
    const interrupted = async (_ctx: SagaContext) => {
      lockLost.set();
      return { shouldNotPersist: true };
    };
    const saga: SagaDef = {
      name: 'post-step-lock-loss',
      steps: [{ name: 'install', operation: 'Install', execute: interrupted }],
    };
    const initial = makePlan([makeStep('install', { attempt: 1 })], {
      metadata: { rewound: true },
    });
    const { manager, plans, rewindCalls } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    await expect(
      runner.execute(saga, {
        planId: 'test-plan',
        payload: {},
        lockLost,
      }),
    ).rejects.toBeInstanceOf(LockLost);

    const saved = plans.get('test-plan');
    expect(saved?.steps[0].status).toBe(JobStatus.PENDING);
    expect(saved?.steps[0].attempt).toBe(1);
    expect(saved?.steps[0].result).toBeNull();
    expect(saved?.metadata).toEqual({ rewound: true });
    expect(rewindCalls).toEqual([]);
    expect(calls.some((call) => call.status === JobStatus.FAILED)).toBe(false);
    expect(calls.some((call) => call.status === JobStatus.COMPLETED)).toBe(false);
  });

  it('reverts a running step to PENDING when the lock is lost before completion is persisted', async () => {
    let lost = false;
    const interrupted = async (_ctx: SagaContext) => {
      lost = true;
      return { shouldNotPersist: true };
    };
    const saga: SagaDef = {
      name: 'post-step-lock-loss',
      steps: [{ name: 'install', operation: 'Install', execute: interrupted }],
    };
    const initial = makePlan([makeStep('install', { attempt: 1 })], {
      metadata: { rewound: true },
    });
    const { manager, plans, rewindCalls } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    await expect(
      runner.execute(saga, {
        planId: 'test-plan',
        payload: {},
        lockLost: { isSet: () => lost },
      }),
    ).rejects.toBeInstanceOf(LockLost);

    const saved = plans.get('test-plan');
    expect(saved?.status).toBe(JobStatus.PENDING);
    expect(saved?.steps[0].status).toBe(JobStatus.PENDING);
    expect(saved?.steps[0].attempt).toBe(1);
    expect(saved?.steps[0].result).toBeNull();
    expect(saved?.metadata).toEqual({ rewound: true });
    expect(rewindCalls).toEqual([]);
    expect(calls.some((call) => call.status === JobStatus.COMPLETED || call.status === JobStatus.FAILED)).toBe(false);
  });

  it('keeps the plan COMPLETED when lock loss is observed after the final step persists', async () => {
    let lost = false;
    const saga: SagaDef = {
      name: 'final-step-lock-loss',
      steps: [{ name: 'install', operation: 'Install', execute: successStep }],
    };
    const initial = makePlan([makeStep('install')]);
    const { manager, plans } = makeInMemoryPlanManager(initial);
    manager.updateStepStatus = vi.fn(async (args: Parameters<PlanManagerService['updateStepStatus']>[0]) => {
      const current = plans.get(args.planId);
      if (!current) return;
      plans.set(
        args.planId,
        transitionPlanStep(current, {
          stepName: args.stepName,
          status: args.status,
          error: args.error,
          result: args.result,
          queueName: args.queueName,
          jobId: args.jobId,
        }),
      );
      if (args.status === JobStatus.COMPLETED) lost = true;
    });
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    const result = await runner.execute(saga, {
      planId: 'test-plan',
      payload: {},
      lockLost: { isSet: () => lost },
    });

    expect(result?.status).toBe(JobStatus.COMPLETED);
    expect(plans.get('test-plan')?.status).toBe(JobStatus.COMPLETED);
    expect(plans.get('test-plan')?.steps[0].status).toBe(JobStatus.COMPLETED);
    expect(calls.some((call) => call.stepName === '__plan__' && call.status === JobStatus.COMPLETED)).toBe(true);
  });

  it('throws a descriptive error if the plan vanishes during the retryable-failure re-fetch', async () => {
    const initial = makePlan([makeStep('wipe'), makeStep('install')]);
    const { manager, plans } = makeInMemoryPlanManager(initial);
    const { notifications } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    manager.getPlan = vi.fn(async (planId: string) => {
      const plan = plans.get(planId) ?? null;
      if (plan?.steps.some((s) => s.step_name === 'install' && s.status === JobStatus.FAILED)) {
        return null;
      }
      return plan;
    });

    await expect(runner.execute(sagaAllFail(), { planId: 'test-plan', payload: { device_id: 42 } })).rejects.toThrow(
      /Plan test-plan not found after failure of step 'install'/,
    );

    expect(plans.has('test-plan')).toBe(true);
  });

  it('skips the __plan__ notification (no null deref) if the plan vanishes after a non-retryable failure', async () => {
    const nonRetryable = async (_ctx: SagaContext): Promise<unknown> => {
      throw new NonRetryableSagaError('frozen payload missing required field');
    };
    const saga: SagaDef = {
      name: 'non-retryable-vanish',
      steps: [{ name: 'install', operation: 'Install', execute: nonRetryable }],
    };
    const initial = makePlan([makeStep('install')]);
    const { manager, plans } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    manager.getPlan = vi.fn(async (planId: string) => {
      const plan = plans.get(planId) ?? null;
      if (plan?.steps.some((s) => s.step_name === 'install' && s.status === JobStatus.FAILED)) {
        return null;
      }
      return plan;
    });

    const result = await runner.execute(saga, { planId: 'test-plan', payload: { device_id: 42 } });
    expect(result).toBeNull();
    expect(calls.some((c) => c.stepName === '__plan__')).toBe(false);
  });

  it('reverts the step to PENDING and rethrows on AgentNotConnected', async () => {
    const noAgent = async (_ctx: SagaContext): Promise<unknown> => {
      throw new AgentNotConnected('42');
    };
    const saga: SagaDef = {
      name: 'needs-agent',
      steps: [{ name: 'dispatch_thing', operation: 'dispatch_thing', execute: noAgent }],
    };
    const initial = makePlan([makeStep('dispatch_thing')]);
    const { manager, plans, rewindCalls } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    await expect(runner.execute(saga, { planId: 'test-plan', payload: { device_id: 42 } })).rejects.toBeInstanceOf(
      AgentNotConnected,
    );

    const saved = plans.get('test-plan');
    const dispatch = saved?.steps.find((s) => s.step_name === 'dispatch_thing');
    expect(dispatch?.status).toBe(JobStatus.PENDING);
    expect(dispatch?.attempt).toBe(0);
    expect(rewindCalls).toEqual([]);
    expect(calls.some((c) => c.stepName === 'dispatch_thing' && c.status === JobStatus.FAILED)).toBe(false);
  });

  it('reverts the step to PENDING and rethrows on ShutdownRequested', async () => {
    const draining = async (_ctx: SagaContext): Promise<unknown> => {
      throw new ShutdownRequested('Brokkr Live readiness wait for device 42 aborted: bridge shutting down');
    };
    const saga: SagaDef = {
      name: 'drained-mid-step',
      steps: [{ name: 'wait_for_brokkr_live', operation: 'wait_for_brokkr_live', execute: draining, maxAttempts: 3 }],
    };
    const initial = makePlan([makeStep('wait_for_brokkr_live')]);
    const { manager, plans, rewindCalls } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    await expect(runner.execute(saga, { planId: 'test-plan', payload: { device_id: 42 } })).rejects.toBeInstanceOf(
      ShutdownRequested,
    );

    const saved = plans.get('test-plan');
    const step = saved?.steps.find((s) => s.step_name === 'wait_for_brokkr_live');
    expect(step?.status).toBe(JobStatus.PENDING);
    expect(step?.attempt).toBe(0);
    expect(rewindCalls).toEqual([]);
    expect(calls.some((c) => c.status === JobStatus.FAILED)).toBe(false);
  });
});

describe('SagaRunner — notification delivery failures', () => {
  function makeFailingNotifications(shouldFail: (event: { stepName: string; status: JobStatus }) => boolean): {
    notifications: NotificationsService;
    failedEvents: Array<{ stepName: string; status: JobStatus }>;
  } {
    const failedEvents: Array<{ stepName: string; status: JobStatus }> = [];
    const notifications = {
      notifyStepTransition: vi.fn(async (event) => {
        if (shouldFail({ stepName: event.stepName, status: event.status })) {
          failedEvents.push({ stepName: event.stepName, status: event.status });
          throw new Error('results queue unavailable');
        }
      }),
    } as unknown as NotificationsService;
    return { notifications, failedEvents };
  }

  it('re-throws so BullMQ retries when the terminal completion notification fails', async () => {
    const initial = makePlan([makeStep('step_a'), makeStep('step_b')]);
    const { manager, plans } = makeInMemoryPlanManager(initial);
    const { notifications, failedEvents } = makeFailingNotifications(
      (e) => e.stepName === '__plan__' && e.status === JobStatus.COMPLETED,
    );
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    await expect(runner.execute(simpleSaga(), { planId: 'test-plan', payload: {} })).rejects.toThrow(
      'results queue unavailable',
    );

    expect(plans.get('test-plan')?.status).toBe(JobStatus.COMPLETED);
    expect(failedEvents).toEqual([{ stepName: '__plan__', status: JobStatus.COMPLETED }]);
  });

  it('re-throws so BullMQ retries when the terminal FAILED notification fails', async () => {
    const initial = makePlan([makeStep('wipe'), makeStep('install')]);
    const { manager, plans } = makeInMemoryPlanManager(initial);
    const { notifications, failedEvents } = makeFailingNotifications(
      (e) => e.stepName === '__plan__' && e.status === JobStatus.FAILED,
    );
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    await expect(runner.execute(sagaAllFail(), { planId: 'test-plan', payload: {} })).rejects.toThrow(
      'results queue unavailable',
    );

    expect(plans.get('test-plan')?.status).toBe(JobStatus.FAILED);
    expect(failedEvents).toEqual([{ stepName: '__plan__', status: JobStatus.FAILED }]);
  });

  it('re-delivers the terminal FAILED notification on a re-run of an already-terminal plan', async () => {
    const initial = makePlan(
      [
        makeStep('wipe', { status: JobStatus.COMPLETED }),
        makeStep('install', { status: JobStatus.FAILED, error: 'boom' }),
      ],
      { status: JobStatus.FAILED, error: 'boom' },
    );
    const { manager } = makeInMemoryPlanManager(initial);
    const { notifications, calls } = makeRecordingNotifications();
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    const result = await runner.execute(sagaAllFail(), { planId: 'test-plan', payload: {} });

    expect(result?.status).toBe(JobStatus.FAILED);
    const planFailures = calls.filter((c) => c.stepName === '__plan__' && c.status === JobStatus.FAILED);
    expect(planFailures.length).toBe(1);
    expect(planFailures[0].error).toBe('boom');
  });

  it('fires the terminal __plan__ notification exactly once on the first pass (COMPLETED and FAILED)', async () => {
    {
      const initial = makePlan([makeStep('step_a'), makeStep('step_b')]);
      const { manager } = makeInMemoryPlanManager(initial);
      const { notifications, calls } = makeRecordingNotifications();
      const runner = new SagaRunnerService(manager, notifications, silentLogger);
      await runner.execute(simpleSaga(), { planId: 'test-plan', payload: {} });
      const done = calls.filter((c) => c.stepName === '__plan__' && c.status === JobStatus.COMPLETED);
      expect(done.length).toBe(1);
    }
    {
      const initial = makePlan([makeStep('wipe'), makeStep('install')]);
      const { manager } = makeInMemoryPlanManager(initial);
      const { notifications, calls } = makeRecordingNotifications();
      const runner = new SagaRunnerService(manager, notifications, silentLogger);
      await runner.execute(sagaAllFail(), { planId: 'test-plan', payload: {} });
      const failed = calls.filter((c) => c.stepName === '__plan__' && c.status === JobStatus.FAILED);
      expect(failed.length).toBe(1);
    }
  });

  it('does not abort the saga when a non-terminal step notification fails', async () => {
    const initial = makePlan([makeStep('step_a'), makeStep('step_b')]);
    const { manager, plans } = makeInMemoryPlanManager(initial);
    const { notifications, failedEvents } = makeFailingNotifications(
      (e) => e.stepName === 'step_a' && e.status === JobStatus.RUNNING,
    );
    const runner = new SagaRunnerService(manager, notifications, silentLogger);

    const result = await runner.execute(simpleSaga(), { planId: 'test-plan', payload: {} });

    expect(result?.status).toBe(JobStatus.COMPLETED);
    expect(plans.get('test-plan')?.status).toBe(JobStatus.COMPLETED);
    expect(failedEvents).toEqual([{ stepName: 'step_a', status: JobStatus.RUNNING }]);
  });
});
