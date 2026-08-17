import { Injectable, Logger } from '@nestjs/common';

import { ShutdownRequested } from '../common/async/shutdown-signal';
import { getErrorMessage } from '../common/error-utils';
import { emitBridgePluginEvent } from '../plugin-host/bridge-plugin-event-holder';

import { AgentNotConnected, AgentNotResponsive } from '../agent/dispatch/grpc.exceptions';
import { NotificationsService, SagaLoggerLike } from './notifications.service';
import { PlanManagerService } from './plan-manager.service';
import type { LifecyclePlan, LifecyclePlanStep } from './plan.types';
import type { SagaContext, SagaDef, SagaStepDef } from './saga.types';
import { JobStatus, TERMINAL_STATUSES } from './state.types';
import { pythonTruthy } from './truthiness';

function defaultLogger(name: string): SagaLoggerLike {
  const nest = new Logger(name);
  return {
    info: (message: string) => nest.log(message),
    warn: (message: string) => nest.warn(message),
    error: (message: string) => nest.error(message),
  };
}

export class LockLost extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LockLost';
  }
}

class SettledStepLockLost extends LockLost {}

export class NonRetryableSagaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableSagaError';
  }
}

// A step error may carry a result that must still be published on the FAILED notification (e.g. a sanitization report is compliance-critical).
export interface StepResultCarrier {
  readonly stepResult: unknown;
}

function stepResultFromError(error: unknown): unknown {
  if (error !== null && typeof error === 'object' && 'stepResult' in error) {
    return (error as StepResultCarrier).stepResult;
  }
  return undefined;
}

export interface LockLostSignal {
  isSet(): boolean;
  wait?(): Promise<void>;
  dispose?(): void;
}

interface LockLostWaiter {
  check(): void;
  isSettled(): boolean;
  readonly waitable: boolean;
  wait(): Promise<void>;
}

function createLockLostWaiter(lockLost: LockLostSignal): LockLostWaiter {
  let settled = false;
  let resolveWait: (() => void) | null = null;
  const waitPromise = new Promise<void>((resolve) => {
    resolveWait = resolve;
  });
  const settle = (): void => {
    if (settled) return;
    settled = true;
    resolveWait?.();
    resolveWait = null;
  };

  if (lockLost.wait !== undefined) {
    void lockLost.wait().then(settle, settle);
  }

  return {
    check: () => {
      if (lockLost.isSet()) settle();
    },
    isSettled: () => settled,
    waitable: lockLost.wait !== undefined,
    wait: () => waitPromise,
  };
}

type StepSettlement = { status: 'fulfilled'; value: unknown } | { status: 'rejected'; reason: unknown };

function startStep(stepDef: SagaStepDef, context: SagaContext): Promise<unknown> {
  try {
    return stepDef.execute(context);
  } catch (error) {
    return Promise.reject(error);
  }
}

async function raceStepAgainstLockLoss(
  stepPromise: Promise<unknown>,
  lockLostWaiter: LockLostWaiter | null,
  stepAbort: AbortController,
  lockLostError: LockLost,
): Promise<unknown> {
  if (lockLostWaiter === null) return stepPromise;

  const lockWasAlreadyLost = lockLostWaiter.isSettled();
  const tracked: { step: StepSettlement | null } = {
    step: null,
  };
  const trackedStep = stepPromise.then(
    (value) => {
      tracked.step = { status: 'fulfilled', value };
    },
    (reason: unknown) => {
      tracked.step = { status: 'rejected', reason };
    },
  );
  const trackedLockLost = lockLostWaiter.wait();

  await Promise.resolve();
  await Promise.race([trackedStep, trackedLockLost]);
  const stepSettledImmediately = tracked.step !== null;
  await Promise.resolve();

  const settlement = tracked.step;
  lockLostWaiter.check();
  if (lockLostWaiter.isSettled()) {
    stepAbort.abort(lockLostError);
    if (
      stepSettledImmediately &&
      settlement !== null &&
      !lockWasAlreadyLost &&
      (!lockLostWaiter.waitable || settlement.status === 'fulfilled')
    ) {
      throw new SettledStepLockLost(lockLostError.message);
    }
    throw lockLostError;
  }
  if (settlement?.status === 'rejected' && settlement.reason instanceof NonRetryableSagaError) {
    throw settlement.reason;
  }
  if (settlement === null) {
    throw new Error('Step race completed without a settled outcome');
  }
  if (settlement.status === 'rejected') throw settlement.reason;
  return settlement.value;
}

export function findStepDef(saga: SagaDef, stepName: string): SagaStepDef | null {
  return saga.steps.find((s) => s.name === stepName) ?? null;
}

export function findNextPendingStep(plan: LifecyclePlan): LifecyclePlanStep | null {
  return plan.steps.find((s) => s.status === JobStatus.PENDING) ?? null;
}

export function findRunningStep(plan: LifecyclePlan): LifecyclePlanStep | null {
  return plan.steps.find((s) => s.status === JobStatus.RUNNING) ?? null;
}

export function isTruthyResult(result: unknown): boolean {
  return pythonTruthy(result);
}

export function collectStepResults(plan: LifecyclePlan): Record<string, unknown> {
  const results: Record<string, unknown> = {};
  for (const step of plan.steps) {
    if (step.status === JobStatus.COMPLETED && isTruthyResult(step.result)) {
      results[step.step_name] = step.result;
    }
  }
  return results;
}

@Injectable()
export class SagaRunnerService {
  private readonly logger: SagaLoggerLike;

  constructor(
    private readonly planManager: PlanManagerService,
    private readonly notifications: NotificationsService,
    logger?: SagaLoggerLike,
  ) {
    this.logger = logger ?? defaultLogger(SagaRunnerService.name);
  }

  private async fireNotification(
    plan: LifecyclePlan,
    stepName: string,
    status: JobStatus,
    opts: {
      error?: string | null;
      result?: unknown;
      attempt?: number;
    } = {},
  ): Promise<void> {
    try {
      await this.notifications.notifyStepTransition({
        planId: plan.plan_id,
        stepName,
        status,
        deviceId: plan.device_id,
        error: opts.error ?? null,
        result: opts.result ?? null,
        attempt: opts.attempt ?? 0,
        metadata: plan.metadata,
      });
    } catch (error) {
      this.logger.error(`Notification failed for plan ${plan.plan_id} step ${stepName}: ${getErrorMessage(error)}`);
      if (stepName === '__plan__' && (status === JobStatus.COMPLETED || status === JobStatus.FAILED)) {
        throw error;
      }
    }
  }

  async execute(
    saga: SagaDef,
    args: {
      planId: string;
      payload: Record<string, unknown>;
      lockLost?: LockLostSignal | null;
    },
  ): Promise<LifecyclePlan | null> {
    await this.planManager.start();

    let plan = await this.planManager.getPlan(args.planId);
    if (plan === null) {
      throw new Error(`Plan ${args.planId} not found`);
    }

    const runningStep = findRunningStep(plan);
    if (runningStep !== null) {
      this.logger.warn(
        `Plan ${args.planId} step '${runningStep.step_name}' remains RUNNING after a worker crash or mid-step lock loss. The runner starts it again.`,
      );
      await this.planManager.updateStepStatus({
        planId: args.planId,
        stepName: runningStep.step_name,
        status: JobStatus.PENDING,
      });
      const refreshed = await this.planManager.getPlan(args.planId);
      if (refreshed === null) {
        throw new Error(`Plan ${args.planId} not found after resetting crashed step '${runningStep.step_name}'`);
      }
      plan = refreshed;
    }

    const lockLostWaiter = args.lockLost ? createLockLostWaiter(args.lockLost) : null;
    let hasRunStep = false;
    const lockLostError = new LockLost(`Device lock lost during saga '${saga.name}' for plan ${args.planId}`);
    try {
      while (true) {
        const current = await this.planManager.getPlan(args.planId);
        if (current === null || TERMINAL_STATUSES.has(current.status)) {
          plan = current;
          break;
        }
        if (hasRunStep && lockLostWaiter !== null) {
          lockLostWaiter.check();
          if (lockLostWaiter.isSettled()) {
            throw lockLostError;
          }
        }
        if (args.lockLost?.isSet() === true) throw lockLostError;

        const step = findNextPendingStep(current);
        if (step === null) {
          plan = current;
          break;
        }

        const stepDef = findStepDef(saga, step.step_name);
        if (stepDef === null) {
          this.logger.error(`No step definition for '${step.step_name}' in saga '${saga.name}'`);
          await this.planManager.updateStepStatus({
            planId: args.planId,
            stepName: step.step_name,
            status: JobStatus.FAILED,
            error: `Unknown step definition: ${step.step_name}`,
          });
          plan = await this.planManager.getPlan(args.planId);
          break;
        }

        const stepAbort = new AbortController();
        const context: SagaContext = {
          planId: args.planId,
          stepName: step.step_name,
          deviceId: current.device_id,
          payload: args.payload,
          jobId: args.planId,
          attempt: step.attempt,
          metadata: { ...current.metadata },
          stepResults: collectStepResults(current),
          signal: stepAbort.signal,
          workId: `${args.planId}:${step.step_name}:${step.attempt}`,
        };

        hasRunStep = true;
        await this.planManager.updateStepStatus({
          planId: args.planId,
          stepName: step.step_name,
          status: JobStatus.RUNNING,
        });
        await this.fireNotification(current, step.step_name, JobStatus.RUNNING, {
          attempt: step.attempt,
        });

        let result: unknown;
        try {
          const stepPromise = startStep(stepDef, context);
          result = await raceStepAgainstLockLoss(stepPromise, lockLostWaiter, stepAbort, lockLostError);
        } catch (error) {
          if (error instanceof NonRetryableSagaError) {
            const errorMsg = getErrorMessage(error);
            this.logger.error(`Saga '${saga.name}' step '${step.step_name}' raised NonRetryableSagaError: ${errorMsg}`);
            await this.planManager.updateStepStatus({
              planId: args.planId,
              stepName: step.step_name,
              status: JobStatus.FAILED,
              error: errorMsg,
            });
            await this.fireNotification(current, step.step_name, JobStatus.FAILED, {
              error: errorMsg,
              result: stepResultFromError(error),
              attempt: step.attempt,
            });
            plan = await this.planManager.getPlan(args.planId);
            break;
          }

          if (error instanceof LockLost) {
            await this.planManager.updateStepStatus({
              planId: args.planId,
              stepName: step.step_name,
              status: JobStatus.PENDING,
            });
            throw error;
          }

          // a drain is not a device failure: leave the step PENDING for stranded_plan_resume to re-enqueue,
          // rather than notifying a FAILED step that the hub would surface as a failed device.
          if (error instanceof ShutdownRequested) {
            this.logger.warn(
              `Saga '${saga.name}' step '${step.step_name}' deferred (bridge shutting down): ${getErrorMessage(error)}`,
            );
            await this.planManager.updateStepStatus({
              planId: args.planId,
              stepName: step.step_name,
              status: JobStatus.PENDING,
            });
            throw error;
          }

          if (error instanceof AgentNotConnected || error instanceof AgentNotResponsive) {
            this.logger.warn(
              `Saga '${saga.name}' step '${step.step_name}' deferred (no local agent): ${getErrorMessage(error)}`,
            );
            await this.planManager.updateStepStatus({
              planId: args.planId,
              stepName: step.step_name,
              status: JobStatus.PENDING,
            });
            throw error;
          }

          const errorMsg = getErrorMessage(error);
          this.logger.error(
            `Saga '${saga.name}' step '${step.step_name}' failed (attempt ${step.attempt + 1}): ${errorMsg}`,
          );
          await this.planManager.updateStepStatus({
            planId: args.planId,
            stepName: step.step_name,
            status: JobStatus.FAILED,
            error: errorMsg,
          });
          await this.fireNotification(current, step.step_name, JobStatus.FAILED, {
            error: errorMsg,
            result: stepResultFromError(error),
            attempt: step.attempt,
          });

          const afterFailure = await this.planManager.getPlan(args.planId);
          if (afterFailure === null) {
            throw new Error(`Plan ${args.planId} not found after failure of step '${step.step_name}'`);
          }
          await this.handleFailure(saga, {
            plan: afterFailure,
            stepName: step.step_name,
            attempt: step.attempt,
            error: errorMsg,
          });
          continue;
        }

        await this.planManager.updateStepStatus({
          planId: args.planId,
          stepName: step.step_name,
          status: JobStatus.COMPLETED,
          result,
        });
        await this.fireNotification(current, step.step_name, JobStatus.COMPLETED, {
          result,
          attempt: step.attempt,
        });
        this.logger.info(`Saga '${saga.name}' step '${step.step_name}' completed`);
        emitBridgePluginEvent('bridge.saga.step.completed', {
          sagaName: saga.name,
          stepName: step.step_name,
          planId: args.planId,
        });
      }

      const finalPlan = await this.planManager.getPlan(args.planId);
      if (finalPlan !== null && finalPlan.status === JobStatus.COMPLETED) {
        await this.fireNotification(finalPlan, '__plan__', JobStatus.COMPLETED);
        this.logger.info(`Saga '${saga.name}' completed for plan ${args.planId}`);
        emitBridgePluginEvent('bridge.saga.completed', { sagaName: saga.name, planId: args.planId });
      } else if (finalPlan !== null && finalPlan.status === JobStatus.FAILED) {
        await this.fireNotification(finalPlan, '__plan__', JobStatus.FAILED, {
          error: finalPlan.error,
        });
        this.logger.info(`Saga '${saga.name}' failed for plan ${args.planId}`);
        emitBridgePluginEvent('bridge.saga.failed', {
          sagaName: saga.name,
          planId: args.planId,
          error: finalPlan.error ?? null,
        });
      }

      return finalPlan;
    } finally {
      args.lockLost?.dispose?.();
    }
  }

  private async handleFailure(
    saga: SagaDef,
    args: {
      plan: LifecyclePlan;
      stepName: string;
      attempt: number;
      error: string;
    },
  ): Promise<LifecyclePlan> {
    const stepDef = findStepDef(saga, args.stepName);
    if (stepDef === null) return args.plan;

    const maxAttempts = stepDef.maxAttempts ?? 1;
    const recovery = stepDef.recovery ?? [];

    if (args.attempt >= maxAttempts - 1 || recovery.length === 0) {
      this.logger.error(`Saga '${saga.name}' step '${args.stepName}' exhausted all recovery attempts`);
      return args.plan;
    }

    const recoveryIndex = Math.min(args.attempt, recovery.length - 1);
    const action = recovery[recoveryIndex];

    this.logger.info(`Saga '${saga.name}' recovery: rewinding to '${action.rewindTo}' (${action.description})`);

    const updated = await this.planManager.rewindPlan({
      planId: args.plan.plan_id,
      rewindTo: action.rewindTo,
      failedStep: args.stepName,
    });
    return updated ?? args.plan;
  }
}
