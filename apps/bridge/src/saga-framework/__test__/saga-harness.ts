import { vi } from 'vitest';

import { NotificationsService } from '../notifications.service';
import { PlanManagerService, rewindStepsFrom, transitionPlanStep } from '../plan-manager.service';
import type { LifecyclePlan, LifecyclePlanStep } from '../plan.types';
import type { SagaContext } from '../saga.types';
import { JobStatus } from '../state.types';

export interface ScriptedOutcome {
  step: string;
  result?: Record<string, unknown> | null;
  error?: string | null;
  excFactory?: ((msg: string) => Error) | null;
}

export interface NotificationEvent {
  planId: string;
  step_name: string;
  status: JobStatus;
  error?: string | null;
  result?: unknown;
  attempt?: number;
}

export interface HarnessObservation {
  finalPlan: LifecyclePlan | null;
  rewindLog: Array<[string, string]>;
  notifications: NotificationEvent[];
  stepInvocations: Array<[string, number]>;
}

export class ScriptedOutcomeQueue {
  private readonly outcomes: ScriptedOutcome[];
  constructor(outcomes: ScriptedOutcome[]) {
    this.outcomes = [...outcomes];
  }
  popLeft(): ScriptedOutcome | undefined {
    return this.outcomes.shift();
  }
  get length(): number {
    return this.outcomes.length;
  }
}

export function makeScriptedStep(
  outcomes: ScriptedOutcomeQueue,
  invocations: Array<[string, number]>,
): (ctx: SagaContext) => Promise<unknown> {
  return async (ctx: SagaContext): Promise<unknown> => {
    invocations.push([ctx.stepName, ctx.attempt]);
    const outcome = outcomes.popLeft();
    if (outcome === undefined) {
      throw new Error(`scripted outcomes exhausted but saga ran step=${ctx.stepName} (attempt=${ctx.attempt})`);
    }
    if (outcome.step !== ctx.stepName) {
      throw new Error(
        `scripted outcome mismatch: expected step=${outcome.step} but saga ran step=${ctx.stepName} (attempt=${ctx.attempt})`,
      );
    }
    if (outcome.excFactory) {
      throw outcome.excFactory(outcome.error ?? '');
    }
    if (outcome.error !== undefined && outcome.error !== null) {
      throw new Error(outcome.error);
    }
    return outcome.result ?? {};
  };
}

export interface InMemoryPlanManagerHandle {
  manager: PlanManagerService;
  plans: Map<string, LifecyclePlan>;
  rewindLog: Array<[string, string]>;
}

export function makeInMemoryPlanManager(
  initialPlan: LifecyclePlan,
  rewindLog: Array<[string, string]>,
): InMemoryPlanManagerHandle {
  const plans = new Map<string, LifecyclePlan>();
  plans.set(initialPlan.plan_id, initialPlan);

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
        queueName?: string | null;
        jobId?: string | null;
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
            queueName: args.queueName ?? null,
            jobId: args.jobId ?? null,
          }),
        );
      },
    ),
    rewindPlan: vi.fn(async (args: { planId: string; rewindTo: string; failedStep: string }) => {
      const current = plans.get(args.planId);
      if (!current) return null;
      const rewound = rewindStepsFrom(current, {
        rewindTo: args.rewindTo,
        failedStep: args.failedStep,
      });
      plans.set(args.planId, rewound);
      rewindLog.push([args.failedStep, args.rewindTo]);
      return rewound;
    }),
  } as unknown as PlanManagerService;

  return { manager, plans, rewindLog };
}

export function makeNotificationRecorder(notifications: NotificationEvent[]): NotificationsService {
  return {
    notifyStepTransition: vi.fn(async (event) => {
      notifications.push({
        planId: event.planId,
        step_name: event.stepName,
        status: event.status,
        error: event.error ?? null,
        result: event.result ?? null,
        attempt: event.attempt ?? 0,
      });
    }),
  } as unknown as NotificationsService;
}

export function makeStep(name: string, overrides: Partial<LifecyclePlanStep> = {}): LifecyclePlanStep {
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

export function makePlan(steps: LifecyclePlanStep[], overrides: Partial<LifecyclePlan> = {}): LifecyclePlan {
  return {
    plan_id: 'plan-1',
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
