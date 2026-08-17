import { afterEach, describe, expect, it } from 'vitest';

import {
  resetBridgePluginEventBusForTests,
  setBridgePluginEventBus,
} from '../../plugin-host/bridge-plugin-event-holder';
import { SagaRunnerService } from '../saga-runner.service';
import type { SagaDef } from '../saga.types';
import {
  ScriptedOutcomeQueue,
  makeInMemoryPlanManager,
  makeNotificationRecorder,
  makePlan,
  makeScriptedStep,
  makeStep,
  type NotificationEvent,
  type ScriptedOutcome,
} from './saga-harness';

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

function recordingBus(): Array<{ event: string; payload: unknown }> {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  setBridgePluginEventBus({
    emit: (event, payload) => {
      emitted.push({ event, payload });
    },
    on: () => () => undefined,
    off: () => undefined,
  });
  return emitted;
}

async function runSaga(stepNames: string[], outcomes: ScriptedOutcome[]): Promise<void> {
  const invocations: Array<[string, number]> = [];
  const rewindLog: Array<[string, string]> = [];
  const notifications: NotificationEvent[] = [];
  const queue = new ScriptedOutcomeQueue(outcomes);
  const execFn = makeScriptedStep(queue, invocations);
  const saga: SagaDef = {
    name: 'provision',
    steps: stepNames.map((name) => ({ name, operation: name, execute: execFn, maxAttempts: 1 })),
  };
  const initial = makePlan(
    stepNames.map((name) => makeStep(name)),
    { plan_id: 'plan-1' },
  );
  const { manager } = makeInMemoryPlanManager(initial, rewindLog);
  const runner = new SagaRunnerService(manager, makeNotificationRecorder(notifications), silentLogger);
  await runner.execute(saga, { planId: 'plan-1', payload: {} });
}

describe('SagaRunnerService plugin event emission', () => {
  afterEach(() => {
    resetBridgePluginEventBusForTests();
  });

  it('emits step and saga completion events for a successful run', async () => {
    const emitted = recordingBus();

    await runSaga(
      ['alpha', 'beta'],
      [
        { step: 'alpha', result: { ok: 1 } },
        { step: 'beta', result: { ok: 2 } },
      ],
    );

    expect(emitted).toEqual([
      { event: 'bridge.saga.step.completed', payload: { sagaName: 'provision', stepName: 'alpha', planId: 'plan-1' } },
      { event: 'bridge.saga.step.completed', payload: { sagaName: 'provision', stepName: 'beta', planId: 'plan-1' } },
      { event: 'bridge.saga.completed', payload: { sagaName: 'provision', planId: 'plan-1' } },
    ]);
  });

  it('emits saga.failed with the plan error for a failed run', async () => {
    const emitted = recordingBus();

    await runSaga(['alpha'], [{ step: 'alpha', error: 'boom' }]);

    expect(emitted).toEqual([
      {
        event: 'bridge.saga.failed',
        payload: { sagaName: 'provision', planId: 'plan-1', error: expect.stringContaining('boom') },
      },
    ]);
  });
});
