import { TestScenarioSchema, type TestScenario } from '@repo/local-lab-contract';
import { describe, expect, it } from 'vitest';

import { baseOsStartBodies, modalKindFor, scenarioStartBodies } from './testing';

const PICKER_KINDS = TestScenarioSchema.shape.picker.unwrap().options;

const scenario = (over: Partial<TestScenario> = {}): TestScenario => ({
  id: 'lifecycle',
  label: 'Lifecycle',
  description: 'provision then deprovision',
  pinNode: true,
  destructive: false,
  ...over,
});

describe('modalKindFor', () => {
  it('routes to the declared picker', () => {
    expect(modalKindFor(scenario({ picker: 'baseos' }))).toBe('baseos');
    expect(modalKindFor(scenario({ picker: 'disklayout' }))).toBe('disklayout');
  });

  it('prefers the picker over the destructive confirm', () => {
    expect(modalKindFor(scenario({ picker: 'plan', destructive: true }))).toBe('plan');
  });

  it('routes a pickerless destructive scenario to the confirm modal', () => {
    expect(modalKindFor(scenario({ destructive: true }))).toBe('confirm');
  });

  it('routes every picker the contract declares', () => {
    for (const picker of PICKER_KINDS) {
      expect(modalKindFor(scenario({ picker })), picker).toBe(picker);
    }
  });

  it('falls through to launch when the picker is one the registry cannot render', () => {
    // @ts-expect-error a contract enum value this build predates
    expect(modalKindFor(scenario({ picker: 'queues' }))).toBeNull();
    // @ts-expect-error a contract enum value this build predates
    expect(modalKindFor(scenario({ picker: 'queues', destructive: true }))).toBe('confirm');
  });

  it('opens no modal for a scenario that launches immediately', () => {
    expect(modalKindFor(scenario())).toBeNull();
  });
});

describe('scenarioStartBodies', () => {
  it('emits one body per selected node', () => {
    expect(scenarioStartBodies(scenario(), [0, 2], [])).toEqual([
      { scenarioId: 'lifecycle', nodeIndex: 0, steps: undefined },
      { scenarioId: 'lifecycle', nodeIndex: 2, steps: undefined },
    ]);
  });

  it('falls back to a single auto-picked target when nothing is selected', () => {
    expect(scenarioStartBodies(scenario(), [], [])).toEqual([
      { scenarioId: 'lifecycle', nodeIndex: null, steps: undefined },
    ]);
  });

  it('ignores the selection when the scenario does not pin nodes', () => {
    expect(scenarioStartBodies(scenario({ pinNode: false }), [1, 3], [])).toEqual([
      { scenarioId: 'lifecycle', nodeIndex: null, steps: undefined },
    ]);
  });

  it('passes selected steps only when the scenario declares a steps list', () => {
    const steps = [{ value: 'provision', label: 'Provision' }];
    expect(scenarioStartBodies(scenario({ steps }), [], ['provision'])[0].steps).toEqual(['provision']);
    expect(scenarioStartBodies(scenario({ steps }), [], [])[0].steps).toBeUndefined();
    expect(scenarioStartBodies(scenario(), [], ['provision'])[0].steps).toBeUndefined();
  });
});

describe('baseOsStartBodies', () => {
  it('emits one body per node assignment', () => {
    expect(
      baseOsStartBodies(scenario(), [
        { nodeIndex: 0, baseOses: ['ubuntu-2204'] },
        { nodeIndex: 1, baseOses: ['ubuntu-2404', 'rocky-9'] },
      ]),
    ).toEqual([
      { scenarioId: 'lifecycle', nodeIndex: 0, baseOses: ['ubuntu-2204'] },
      { scenarioId: 'lifecycle', nodeIndex: 1, baseOses: ['ubuntu-2404', 'rocky-9'] },
    ]);
  });

  it('emits nothing when the picker produced no assignments', () => {
    expect(baseOsStartBodies(scenario(), [])).toEqual([]);
  });
});
