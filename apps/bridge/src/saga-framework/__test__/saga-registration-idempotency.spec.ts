
import { beforeEach, describe, expect, it } from 'vitest';

import { clearSagaRegistry, listSagaDefs, registerSagaDef, SagaRegistryService } from '../saga-registry';
import type { SagaDef } from '../saga.types';

import { BUILTIN_SAGAS, POWER_ON_SAGA } from './builtin-sagas.fixture';
import { stubSagaStep } from './stub-saga-steps';

describe('saga-registry single-path contract', () => {
  beforeEach(() => {
    clearSagaRegistry();
  });

  it('registers all 16 builtin saga defs exactly once', () => {
    for (const saga of BUILTIN_SAGAS) {
      registerSagaDef(saga);
    }
    expect(listSagaDefs()).toHaveLength(16);
    const names = listSagaDefs()
      .map((s) => s.name)
      .sort();
    const expected = BUILTIN_SAGAS.map((s) => s.name).sort();
    expect(names).toEqual(expected);
  });

  it('throws on duplicate registration', () => {
    registerSagaDef(POWER_ON_SAGA);
    expect(() => registerSagaDef(POWER_ON_SAGA)).toThrow(`Saga '${POWER_ON_SAGA.name}' is already registered`);
  });

  it('full registry is reusable across containers — clear, then re-register all 16 with no throw', () => {
    for (const saga of BUILTIN_SAGAS) {
      registerSagaDef(saga);
    }
    expect(listSagaDefs()).toHaveLength(16);

    clearSagaRegistry();
    expect(listSagaDefs()).toHaveLength(0);

    expect(() => {
      for (const saga of BUILTIN_SAGAS) {
        registerSagaDef(saga);
      }
    }).not.toThrow();
    expect(listSagaDefs()).toHaveLength(16);
  });
});

describe('saga-registry recovery rewindTo validation', () => {
  it('every builtin saga recovery rewindTo resolves to a declared step in the same saga', () => {
    for (const saga of BUILTIN_SAGAS) {
      const stepNames = new Set(saga.steps.map((step) => step.name));
      for (const step of saga.steps) {
        for (const recovery of step.recovery ?? []) {
          expect(
            stepNames.has(recovery.rewindTo),
            `${saga.name}.${step.name} rewindTo '${recovery.rewindTo}' does not match any step name`,
          ).toBe(true);
        }
      }
    }
  });

  it('register() throws when a recovery rewindTo matches no declared step', () => {
    const registry = new SagaRegistryService();
    const badSaga: SagaDef = {
      name: 'synthetic_bad_saga',
      steps: [
        { name: 'first', execute: stubSagaStep.execute },
        {
          name: 'second',
          execute: stubSagaStep.execute,
          recovery: [{ rewindTo: 'does_not_exist', description: 'bogus' }],
        },
      ],
    };

    expect(() => registry.register(badSaga)).toThrow(
      "Saga 'synthetic_bad_saga' step 'second' has recovery rewindTo 'does_not_exist' that matches no declared step",
    );
  });
});
