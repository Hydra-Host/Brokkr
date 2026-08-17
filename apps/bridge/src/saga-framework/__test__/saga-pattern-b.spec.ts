import { describe, expect, it } from 'vitest';

import { AgentNotConnected, AgentNotResponsive } from '../../agent/dispatch/grpc.exceptions';
import { NotificationsService } from '../notifications.service';
import { transitionPlanStep } from '../plan-manager.service';
import { LockLost, NonRetryableSagaError, SagaRunnerService } from '../saga-runner.service';
import type { RecoveryAction, SagaContext, SagaDef } from '../saga.types';
import { JobStatus } from '../state.types';
import {
  HarnessObservation,
  ScriptedOutcome,
  ScriptedOutcomeQueue,
  makeInMemoryPlanManager,
  makeNotificationRecorder,
  makePlan,
  makeScriptedStep,
  makeStep,
  type NotificationEvent,
} from './saga-harness';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

type StepSpec = [string] | [string, number] | [string, number, RecoveryAction[]];

class WaitableLockLostSignal {
  private fired = false;
  private readonly waiters: Array<() => void> = [];
  waitCalls = 0;

  isSet(): boolean {
    return this.fired;
  }

  async wait(): Promise<void> {
    this.waitCalls += 1;
    if (this.fired) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  set(): void {
    if (this.fired) return;
    this.fired = true;
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  get waiterCount(): number {
    return this.waiters.length;
  }
}

function buildSaga(name: string, specs: StepSpec[]): SagaDef {
  const stub = async () => ({});
  return {
    name,
    steps: specs.map((spec) => {
      if (spec.length === 1) {
        return { name: spec[0], operation: spec[0], execute: stub };
      }
      if (spec.length === 2) {
        return {
          name: spec[0],
          operation: spec[0],
          execute: stub,
          maxAttempts: spec[1],
        };
      }
      return {
        name: spec[0],
        operation: spec[0],
        execute: stub,
        maxAttempts: spec[1],
        recovery: spec[2],
      };
    }),
  };
}

async function runWithHarness(
  saga: SagaDef,
  initial: ReturnType<typeof makePlan>,
  outcomes: ScriptedOutcome[],
): Promise<HarnessObservation> {
  const invocations: Array<[string, number]> = [];
  const rewindLog: Array<[string, string]> = [];
  const notifications: ReturnType<typeof Array<never>> = [] as never[];

  const queue = new ScriptedOutcomeQueue(outcomes);
  const execFn = makeScriptedStep(queue, invocations);
  const rebuilt: SagaDef = {
    name: saga.name,
    steps: saga.steps.map((sd) => ({
      name: sd.name,
      operation: sd.operation,
      execute: execFn,
      recovery: sd.recovery,
      maxAttempts: sd.maxAttempts,
    })),
  };

  const { manager } = makeInMemoryPlanManager(initial, rewindLog);
  const notifyService = makeNotificationRecorder(notifications);
  const runner = new SagaRunnerService(manager, notifyService, silentLogger);

  const finalPlan = await runner.execute(rebuilt, {
    planId: initial.plan_id,
    payload: { hello: 'world' },
  });

  return {
    finalPlan,
    rewindLog,
    notifications,
    stepInvocations: invocations,
  };
}

describe('Pattern B: happy path', () => {
  it('three-step saga completes with ordered notifications', async () => {
    const saga = buildSaga('three-step', [['validate'], ['provision'], ['verify']]);
    const initial = makePlan([makeStep('validate'), makeStep('provision'), makeStep('verify')]);
    const outcomes: ScriptedOutcome[] = [
      { step: 'validate', result: { validated: true } },
      { step: 'provision', result: { provisioned: true } },
      { step: 'verify', result: { verified: true } },
    ];

    const obs = await runWithHarness(saga, initial, outcomes);

    expect(obs.finalPlan?.status).toBe(JobStatus.COMPLETED);
    expect(obs.finalPlan?.steps.map((s) => s.status)).toEqual([
      JobStatus.COMPLETED,
      JobStatus.COMPLETED,
      JobStatus.COMPLETED,
    ]);
    expect(obs.stepInvocations).toEqual([
      ['validate', 0],
      ['provision', 0],
      ['verify', 0],
    ]);
    expect(obs.rewindLog).toEqual([]);

    const order = obs.notifications.map((n) => [n.step_name, n.status]);
    expect(order).toEqual([
      ['validate', JobStatus.RUNNING],
      ['validate', JobStatus.COMPLETED],
      ['provision', JobStatus.RUNNING],
      ['provision', JobStatus.COMPLETED],
      ['verify', JobStatus.RUNNING],
      ['verify', JobStatus.COMPLETED],
      ['__plan__', JobStatus.COMPLETED],
    ]);
  });
});

describe('Pattern B: rewind then retry', () => {
  it('step failure triggers rewind then retry succeeds', async () => {
    const recovery: RecoveryAction[] = [{ rewindTo: 'wipe', description: 'rewipe and retry' }];
    const saga = buildSaga('recovery-once', [['wipe'], ['install', 2, recovery]]);
    const initial = makePlan([makeStep('wipe'), makeStep('install')]);
    const outcomes: ScriptedOutcome[] = [
      { step: 'wipe', result: { wiped: true } },
      { step: 'install', error: 'install transient' },
      { step: 'wipe', result: { wiped: true } },
      { step: 'install', result: { installed: true } },
    ];

    const obs = await runWithHarness(saga, initial, outcomes);

    expect(obs.finalPlan?.status).toBe(JobStatus.COMPLETED);
    const install = obs.finalPlan?.steps.find((s) => s.step_name === 'install');
    expect(install?.status).toBe(JobStatus.COMPLETED);
    expect(install?.attempt).toBe(1);
    expect(obs.rewindLog).toEqual([['install', 'wipe']]);
    expect(obs.stepInvocations).toEqual([
      ['wipe', 0],
      ['install', 0],
      ['wipe', 0],
      ['install', 1],
    ]);
  });
});

describe('Pattern B: retry exhaustion', () => {
  it('marks saga FAILED with error message', async () => {
    const recovery: RecoveryAction[] = [{ rewindTo: 'wipe', description: 'rewipe and retry' }];
    const saga = buildSaga('always-fail', [['wipe'], ['install', 2, recovery]]);
    const initial = makePlan([makeStep('wipe'), makeStep('install')]);
    const errorMsg = 'permanent install failure';
    const outcomes: ScriptedOutcome[] = [
      { step: 'wipe', result: { wiped: true } },
      { step: 'install', error: errorMsg },
      { step: 'wipe', result: { wiped: true } },
      { step: 'install', error: errorMsg },
    ];

    const obs = await runWithHarness(saga, initial, outcomes);

    expect(obs.finalPlan?.status).toBe(JobStatus.FAILED);
    const install = obs.finalPlan?.steps.find((s) => s.step_name === 'install');
    expect(install?.status).toBe(JobStatus.FAILED);
    expect(install?.attempt).toBe(1);
    expect(install?.error).toBe(errorMsg);
    expect(obs.finalPlan?.error).toBe(errorMsg);
    expect(obs.rewindLog).toEqual([['install', 'wipe']]);

    const planFailed = obs.notifications.filter((n) => n.step_name === '__plan__' && n.status === JobStatus.FAILED);
    expect(planFailed.length).toBe(1);
    expect(planFailed[0].error).toBe(errorMsg);
  });
});

describe('Pattern B: agent unavailable', () => {
  it('AgentNotConnected reverts step to PENDING and rethrows', async () => {
    const saga = buildSaga('needs-agent', [['dispatch']]);
    const initial = makePlan([makeStep('dispatch')]);
    const outcomes: ScriptedOutcome[] = [
      {
        step: 'dispatch',
        error: '42',
        excFactory: (msg: string) => new AgentNotConnected(msg || '42'),
      },
    ];

    const invocations: Array<[string, number]> = [];
    const rewindLog: Array<[string, string]> = [];
    const notifications: never[] = [];
    const queue = new ScriptedOutcomeQueue(outcomes);
    const execFn = makeScriptedStep(queue, invocations);
    const rebuilt: SagaDef = {
      name: saga.name,
      steps: saga.steps.map((sd) => ({
        name: sd.name,
        operation: sd.operation,
        execute: execFn,
      })),
    };
    const { manager, plans } = makeInMemoryPlanManager(initial, rewindLog);
    const notifyService = makeNotificationRecorder(notifications);
    const runner = new SagaRunnerService(manager, notifyService, silentLogger);

    await expect(runner.execute(rebuilt, { planId: initial.plan_id, payload: {} })).rejects.toBeInstanceOf(
      AgentNotConnected,
    );

    const saved = plans.get(initial.plan_id);
    const dispatch = saved?.steps.find((s) => s.step_name === 'dispatch');
    expect(dispatch?.status).toBe(JobStatus.PENDING);
    expect(dispatch?.attempt).toBe(0);
    expect(rewindLog).toEqual([]);
    expect(
      notifications.some(
        (n: { step_name: string; status: JobStatus }) => n.step_name === 'dispatch' && n.status === JobStatus.FAILED,
      ),
    ).toBe(false);
  });

  it('AgentNotResponsive is treated the same way', async () => {
    const saga = buildSaga('needs-agent', [['dispatch']]);
    const initial = makePlan([makeStep('dispatch')]);
    const outcomes: ScriptedOutcome[] = [
      {
        step: 'dispatch',
        error: 'saturated',
        excFactory: () => new AgentNotResponsive('42', 0),
      },
    ];
    const invocations: Array<[string, number]> = [];
    const rewindLog: Array<[string, string]> = [];
    const notifications: never[] = [];
    const queue = new ScriptedOutcomeQueue(outcomes);
    const execFn = makeScriptedStep(queue, invocations);
    const rebuilt: SagaDef = {
      name: saga.name,
      steps: saga.steps.map((sd) => ({
        name: sd.name,
        operation: sd.operation,
        execute: execFn,
      })),
    };
    const { manager, plans } = makeInMemoryPlanManager(initial, rewindLog);
    const notifyService = makeNotificationRecorder(notifications);
    const runner = new SagaRunnerService(manager, notifyService, silentLogger);

    await expect(runner.execute(rebuilt, { planId: initial.plan_id, payload: {} })).rejects.toBeInstanceOf(
      AgentNotResponsive,
    );

    const saved = plans.get(initial.plan_id);
    expect(saved?.steps[0].status).toBe(JobStatus.PENDING);
    expect(saved?.steps[0].attempt).toBe(0);
  });
});

describe('Pattern B: external cancellation', () => {
  it('mid-run CANCELLED halts the loop', async () => {
    const saga = buildSaga('cancel-mid', [['step_a'], ['step_b'], ['step_c']]);
    const initial = makePlan([makeStep('step_a'), makeStep('step_b'), makeStep('step_c')]);

    const invocations: Array<[string, number]> = [];
    const rewindLog: Array<[string, string]> = [];
    const notifications: NonNullable<ReturnType<typeof Array<never>>> = [] as never[];

    const handle = makeInMemoryPlanManager(initial, rewindLog);
    const { manager, plans } = handle;
    const originalUpdate = manager.updateStepStatus.bind(manager);
    manager.updateStepStatus = (async (args: {
      planId: string;
      stepName: string;
      status: JobStatus;
      error?: string | null;
      result?: unknown;
    }) => {
      await originalUpdate(args);
      if (args.stepName === 'step_a' && args.status === JobStatus.COMPLETED) {
        const current = plans.get(args.planId);
        if (!current) return;
        let cancelled = transitionPlanStep(current, {
          stepName: 'step_b',
          status: JobStatus.CANCELLED,
        });
        cancelled = transitionPlanStep(cancelled, {
          stepName: 'step_c',
          status: JobStatus.CANCELLED,
        });
        plans.set(args.planId, cancelled);
      }
    }) as typeof manager.updateStepStatus;

    const outcomes: ScriptedOutcome[] = [{ step: 'step_a', result: { a: true } }];
    const queue = new ScriptedOutcomeQueue(outcomes);
    const execFn = makeScriptedStep(queue, invocations);
    const rebuilt: SagaDef = {
      name: saga.name,
      steps: saga.steps.map((sd) => ({
        name: sd.name,
        operation: sd.operation,
        execute: execFn,
      })),
    };
    const notifyService = makeNotificationRecorder(notifications);
    const runner = new SagaRunnerService(manager, notifyService, silentLogger);

    const result = await runner.execute(rebuilt, {
      planId: initial.plan_id,
      payload: {},
    });

    expect(result?.status).toBe(JobStatus.CANCELLED);
    expect(invocations).toEqual([['step_a', 0]]);
    expect(
      notifications.some(
        (n: { step_name: string; status: JobStatus }) => n.step_name === '__plan__' && n.status === JobStatus.COMPLETED,
      ),
    ).toBe(false);
  });
});

describe('Pattern B: lock loss and crash recovery', () => {
  it('leaves the interrupted step PENDING and recovers it on the next execution', async () => {
    const recovery: RecoveryAction[] = [{ rewindTo: 'step_a', description: 'retry interrupted work' }];
    const initial = makePlan([makeStep('step_a'), makeStep('step_b')]);
    const invocations: Array<[string, number]> = [];
    const rewindLog: Array<[string, string]> = [];
    const notifications: NotificationEvent[] = [];
    const lockLost = new WaitableLockLostSignal();
    const execute = async (context: SagaContext): Promise<unknown> => {
      invocations.push([context.stepName, context.attempt]);
      if (context.stepName === 'step_a' && context.attempt === 0) {
        lockLost.set();
        throw new Error('step interrupted');
      }
      return { ok: true };
    };
    const saga: SagaDef = {
      name: 'lock-loss-resume',
      steps: [
        {
          name: 'step_a',
          operation: 'step_a',
          execute,
          maxAttempts: 2,
          recovery,
        },
        { name: 'step_b', operation: 'step_b', execute },
      ],
    };
    const { manager, plans } = makeInMemoryPlanManager(initial, rewindLog);
    const runner = new SagaRunnerService(manager, makeNotificationRecorder(notifications), silentLogger);

    await expect(
      runner.execute(saga, {
        planId: initial.plan_id,
        payload: { device_id: 42 },
        lockLost,
      }),
    ).rejects.toBeInstanceOf(LockLost);

    const interrupted = plans.get(initial.plan_id);
    expect(interrupted?.steps.map((step) => step.status)).toEqual([JobStatus.PENDING, JobStatus.PENDING]);
    expect(interrupted?.steps[0].attempt).toBe(0);
    expect(rewindLog).toEqual([]);
    expect(invocations).toEqual([['step_a', 0]]);
    expect(
      notifications.some(
        (notification) => notification.step_name === 'step_a' && notification.status === JobStatus.FAILED,
      ),
    ).toBe(false);

    const final = await runner.execute(saga, {
      planId: initial.plan_id,
      payload: { device_id: 42 },
    });

    expect(final?.status).toBe(JobStatus.COMPLETED);
    expect(final?.steps.map((step) => step.status)).toEqual([JobStatus.COMPLETED, JobStatus.COMPLETED]);
    expect(final?.steps[0].attempt).toBe(1);
    expect(rewindLog).toEqual([['step_a', 'step_a']]);
    expect(invocations).toEqual([
      ['step_a', 0],
      ['step_a', 0],
      ['step_a', 1],
      ['step_b', 0],
    ]);
  });

  it('prioritizes settled lock loss over a non-retryable step failure', async () => {
    const initial = makePlan([makeStep('step_a')]);
    const lockLost = new WaitableLockLostSignal();
    const saga: SagaDef = {
      name: 'non-retryable-lock-loss',
      steps: [
        {
          name: 'step_a',
          operation: 'step_a',
          execute: async () => {
            lockLost.set();
            throw new NonRetryableSagaError('step cannot be retried');
          },
        },
      ],
    };
    const { manager, plans } = makeInMemoryPlanManager(initial, []);
    const notifications: NotificationEvent[] = [];
    const runner = new SagaRunnerService(manager, makeNotificationRecorder(notifications), silentLogger);

    await expect(
      runner.execute(saga, {
        planId: initial.plan_id,
        payload: {},
        lockLost,
      }),
    ).rejects.toBeInstanceOf(LockLost);

    expect(plans.get(initial.plan_id)?.steps[0].status).toBe(JobStatus.PENDING);
    expect(notifications.some((notification) => notification.status === JobStatus.FAILED)).toBe(false);
  });

  it('handles an ordinary rejected step while the lock-loss waiter is active', async () => {
    const initial = makePlan([makeStep('step_a')]);
    const lockLost = new WaitableLockLostSignal();
    let waiterWasActive = false;
    const saga: SagaDef = {
      name: 'rejected-step',
      steps: [
        {
          name: 'step_a',
          operation: 'step_a',
          execute: async () => {
            await Promise.resolve();
            waiterWasActive = lockLost.waiterCount === 1;
            throw new Error('step rejected');
          },
        },
      ],
    };
    const { manager } = makeInMemoryPlanManager(initial, []);
    const runner = new SagaRunnerService(manager, makeNotificationRecorder([]), silentLogger);

    const final = await runner.execute(saga, {
      planId: initial.plan_id,
      payload: {},
      lockLost,
    });

    expect(waiterWasActive).toBe(true);
    expect(lockLost.waitCalls).toBe(1);
    expect(final?.status).toBe(JobStatus.FAILED);
    expect(final?.steps[0].status).toBe(JobStatus.FAILED);
    expect(final?.steps[0].error).toBe('step rejected');
    lockLost.set();
  });

  it('resumes a lock-interrupted PENDING step in a fresh execution without recovery', async () => {
    const recovery: RecoveryAction[] = [{ rewindTo: 'prepare', description: 'prepare again' }];
    const initial = makePlan([makeStep('prepare'), makeStep('install')]);
    const invocations: Array<[string, number]> = [];
    const rewindLog: Array<[string, string]> = [];
    const notifications: never[] = [];
    let lost = false;
    let firstExecution = true;
    const execute = async (ctx: SagaContext): Promise<unknown> => {
      invocations.push([ctx.stepName, ctx.attempt]);
      if (ctx.stepName === 'install' && firstExecution) {
        lost = true;
        throw new Error('install interrupted');
      }
      return { ok: true };
    };
    const saga: SagaDef = {
      name: 'lock-loss-resume',
      steps: [
        { name: 'prepare', operation: 'Prepare', execute },
        {
          name: 'install',
          operation: 'Install',
          execute,
          maxAttempts: 2,
          recovery,
        },
      ],
    };
    const { manager, plans } = makeInMemoryPlanManager(initial, rewindLog);
    const notifyService = makeNotificationRecorder(notifications);
    const firstRunner = new SagaRunnerService(manager, notifyService, silentLogger);

    await expect(
      firstRunner.execute(saga, {
        planId: initial.plan_id,
        payload: {},
        lockLost: { isSet: () => lost },
      }),
    ).rejects.toBeInstanceOf(LockLost);

    expect(plans.get(initial.plan_id)?.steps.map((step) => step.status)).toEqual([
      JobStatus.COMPLETED,
      JobStatus.PENDING,
    ]);
    expect(plans.get(initial.plan_id)?.steps[1].attempt).toBe(0);
    expect(rewindLog).toEqual([]);
    expect(
      notifications.some((notification: { status: JobStatus }) => notification.status === JobStatus.FAILED),
    ).toBe(false);

    firstExecution = false;
    lost = false;
    const secondRunner = new SagaRunnerService(manager, notifyService, silentLogger);
    const result = await secondRunner.execute(saga, {
      planId: initial.plan_id,
      payload: {},
      lockLost: { isSet: () => lost },
    });

    expect(result?.status).toBe(JobStatus.COMPLETED);
    expect(result?.steps.map((step) => step.status)).toEqual([JobStatus.COMPLETED, JobStatus.COMPLETED]);
    expect(result?.steps[1].attempt).toBe(0);
    expect(rewindLog).toEqual([]);
    expect(invocations).toEqual([
      ['prepare', 0],
      ['install', 0],
      ['install', 0],
    ]);
  });

  it('resumes a lock-interrupted step without consuming a recovery attempt', async () => {
    const recovery: RecoveryAction[] = [{ rewindTo: 'prepare', description: 'prepare again' }];
    const initial = makePlan([makeStep('prepare'), makeStep('install')]);
    const invocations: Array<[string, number]> = [];
    const rewindLog: Array<[string, string]> = [];
    const notifications: never[] = [];
    let lost = false;
    let firstExecution = true;
    const execute = async (ctx: SagaContext): Promise<unknown> => {
      invocations.push([ctx.stepName, ctx.attempt]);
      if (ctx.stepName === 'install' && firstExecution) {
        lost = true;
      }
      return { ok: true };
    };
    const saga: SagaDef = {
      name: 'lock-loss-resume',
      steps: [
        { name: 'prepare', operation: 'Prepare', execute },
        {
          name: 'install',
          operation: 'Install',
          execute,
          maxAttempts: 2,
          recovery,
        },
      ],
    };
    const { manager, plans } = makeInMemoryPlanManager(initial, rewindLog);
    const notifyService = makeNotificationRecorder(notifications);
    const firstRunner = new SagaRunnerService(manager, notifyService, silentLogger);

    await expect(
      firstRunner.execute(saga, {
        planId: initial.plan_id,
        payload: {},
        lockLost: { isSet: () => lost },
      }),
    ).rejects.toBeInstanceOf(LockLost);

    expect(plans.get(initial.plan_id)?.steps.map((step) => step.status)).toEqual([
      JobStatus.COMPLETED,
      JobStatus.PENDING,
    ]);
    expect(plans.get(initial.plan_id)?.steps[1].attempt).toBe(0);
    expect(rewindLog).toEqual([]);
    expect(
      notifications.some(
        (notification: { status: JobStatus }) =>
          notification.status === JobStatus.FAILED || notification.status === JobStatus.CANCELLED,
      ),
    ).toBe(false);

    firstExecution = false;
    lost = false;
    const secondRunner = new SagaRunnerService(manager, notifyService, silentLogger);
    const result = await secondRunner.execute(saga, {
      planId: initial.plan_id,
      payload: {},
      lockLost: { isSet: () => lost },
    });

    expect(result?.status).toBe(JobStatus.COMPLETED);
    expect(result?.steps.map((step) => step.status)).toEqual([JobStatus.COMPLETED, JobStatus.COMPLETED]);
    expect(result?.steps[1].attempt).toBe(0);
    expect(rewindLog).toEqual([]);
    expect(invocations).toEqual([
      ['prepare', 0],
      ['install', 0],
      ['install', 0],
    ]);
  });
});

describe('Pattern B: no recovery', () => {
  it('failure without recovery fails saga immediately', async () => {
    const saga = buildSaga('no-recovery', [['step_a'], ['step_b']]);
    const initial = makePlan([makeStep('step_a'), makeStep('step_b')]);
    const outcomes: ScriptedOutcome[] = [
      { step: 'step_a', result: { ok: true } },
      { step: 'step_b', error: 'boom' },
    ];

    const obs = await runWithHarness(saga, initial, outcomes);

    expect(obs.finalPlan?.status).toBe(JobStatus.FAILED);
    expect(obs.rewindLog).toEqual([]);
    const stepB = obs.finalPlan?.steps.find((s) => s.step_name === 'step_b');
    expect(stepB?.status).toBe(JobStatus.FAILED);
    expect(stepB?.error).toBe('boom');
    expect(obs.finalPlan?.error).toBe('boom');

    const planFailed = obs.notifications.filter((n) => n.step_name === '__plan__' && n.status === JobStatus.FAILED);
    expect(planFailed.length).toBe(1);
  });
});

describe('Pattern B: nested recovery', () => {
  it('selects recovery action by attempt index', async () => {
    const recovery: RecoveryAction[] = [
      { rewindTo: 'step_a', description: 'full reset' },
      { rewindTo: 'step_b', description: 'partial reset' },
    ];
    const saga = buildSaga('nested-recovery', [['step_a'], ['step_b'], ['step_c', 3, recovery]]);
    const initial = makePlan([makeStep('step_a'), makeStep('step_b'), makeStep('step_c')]);
    const outcomes: ScriptedOutcome[] = [
      { step: 'step_a', result: {} },
      { step: 'step_b', result: {} },
      { step: 'step_c', error: 'fail #1' },
      { step: 'step_a', result: {} },
      { step: 'step_b', result: {} },
      { step: 'step_c', error: 'fail #2' },
      { step: 'step_b', result: {} },
      { step: 'step_c', result: { finally: true } },
    ];

    const obs = await runWithHarness(saga, initial, outcomes);

    expect(obs.finalPlan?.status).toBe(JobStatus.COMPLETED);
    expect(obs.rewindLog).toEqual([
      ['step_c', 'step_a'],
      ['step_c', 'step_b'],
    ]);
    const stepC = obs.finalPlan?.steps.find((s) => s.step_name === 'step_c');
    expect(stepC?.attempt).toBe(2);
    expect(stepC?.status).toBe(JobStatus.COMPLETED);
  });
});

describe('Pattern B: step results passing', () => {
  it('downstream steps see prior step results on the context', async () => {
    const saga = buildSaga('results-passing', [['producer'], ['consumer']]);
    const initial = makePlan([makeStep('producer'), makeStep('consumer')]);

    const seenContexts: Array<Record<string, unknown>> = [];
    const customExec = async (ctx: SagaContext): Promise<unknown> => {
      seenContexts.push({ ...ctx.stepResults });
      if (ctx.stepName === 'producer') {
        return { token: 'abc-123', size: 42 };
      }
      return { received: true };
    };
    const rebuilt: SagaDef = {
      name: saga.name,
      steps: saga.steps.map((sd) => ({
        name: sd.name,
        operation: sd.operation,
        execute: customExec,
      })),
    };

    const rewindLog: Array<[string, string]> = [];
    const notifications: never[] = [];
    const { manager } = makeInMemoryPlanManager(initial, rewindLog);
    const notifyService: NotificationsService = makeNotificationRecorder(notifications);
    const runner = new SagaRunnerService(manager, notifyService, silentLogger);

    const result = await runner.execute(rebuilt, {
      planId: initial.plan_id,
      payload: {},
    });

    expect(result?.status).toBe(JobStatus.COMPLETED);
    expect(seenContexts[0]).toEqual({});
    expect(seenContexts[1]).toEqual({ producer: { token: 'abc-123', size: 42 } });
    const producer = result?.steps.find((s) => s.step_name === 'producer');
    expect(producer?.result).toEqual({ token: 'abc-123', size: 42 });
  });
});
