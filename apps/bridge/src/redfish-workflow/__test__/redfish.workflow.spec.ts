import { describe, expect, it } from 'vitest';

import { stubSagaStep } from '../../saga-framework/__test__/stub-saga-steps';
import { clearSagaRegistry, getSagaDef, registerSagaDef } from '../../saga-framework/saga-registry';
import { buildRedfishSaga } from '../redfish.workflow';

const REDFISH_SAGA = buildRedfishSaga({ redfishCommand: stubSagaStep });

describe('REDFISH_SAGA', () => {
  it('has the expected shape', () => {
    expect(REDFISH_SAGA.name).toBe('redfish');
    expect(REDFISH_SAGA.steps.map((s) => s.name)).toEqual(['redfish_command']);
  });

  it('every step has a non-empty execute function', () => {
    for (const step of REDFISH_SAGA.steps) {
      expect(typeof step.execute).toBe('function');
    }
  });
});

describe('redfish registered via registry', () => {
  it('returns the saga when registered, null otherwise', () => {
    clearSagaRegistry();
    expect(getSagaDef('redfish')).toBeNull();
    registerSagaDef(REDFISH_SAGA);
    const saga = getSagaDef('redfish');
    expect(saga).not.toBeNull();
    expect(saga?.name).toBe('redfish');
    expect(saga?.steps.length).toBeGreaterThan(0);
    clearSagaRegistry();
  });

  it('returns null for an unknown saga name', () => {
    clearSagaRegistry();
    registerSagaDef(REDFISH_SAGA);
    expect(getSagaDef('nonexistent')).toBeNull();
    clearSagaRegistry();
  });
});
