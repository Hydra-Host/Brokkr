/**
 * Plan-engine unit tests — pure logic, NO live stack required.
 *
 * Covers plan resolution/validation and the step registry, so the assemblable
 * contract (preset names, inline plan JSON, step ids, cleanup flags) is pinned
 * independently of the slow live journeys. Run with:
 *   npx vitest run tests/ts-e2e/plan/engine.test.ts --config tests/ts-e2e/vitest.config.ts
 */

import { describe, expect, it } from 'vitest';

import { PRESETS, resolvePlan, validatePlan } from './presets';
import { getStep, stepCatalog } from './steps';

describe('step registry', () => {
  it('exposes the assemblable steps', () => {
    const ids = stepCatalog().map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'provision',
        'reprovision',
        'power-cycle',
        'end-rental',
        'verify-os',
        'verify-layers',
        'verify-disk',
        'rescue-activate',
        'rescue-deactivate',
        'verify-cloud-init',
        'provision-ipxe-custom',
        'spoke-failover',
        'spoke-resume',
      ]),
    );
  });

  it('resolves a known step and rejects an unknown one (listing known ids)', () => {
    expect(getStep('provision').label).toBe('Provision');
    expect(() => getStep('nope')).toThrow(/unknown step 'nope'.*known:/s);
  });
});

describe('presets', () => {
  it('lifecycle-full is provision -> reprovision -> power-cycle -> end-rental(cleanup)', () => {
    const p = PRESETS['lifecycle-full']!;
    expect(p.steps.map((s) => s.step)).toEqual(['provision', 'reprovision', 'power-cycle', 'end-rental']);
    expect(p.steps.at(-1)?.always).toBe(true);
  });

  it('resolvePlan returns a preset by name', () => {
    expect(resolvePlan('lifecycle-quick').name).toBe('lifecycle-quick');
  });

  it('ships the journey-analog presets, each ending in an always-cleanup end-rental', () => {
    for (const name of [
      'base-os',
      'disk-layout',
      'layers',
      'rescue',
      'cloud-init',
      'custom-ipxe',
      'spoke-failover',
      'spoke-resume',
    ]) {
      const p = PRESETS[name]!;
      expect(p, `preset '${name}'`).toBeTruthy();
      expect(p.steps.at(-1), `preset '${name}' last step`).toMatchObject({ step: 'end-rental', always: true });
    }
  });

  it('every preset references only registered steps', () => {
    for (const p of Object.values(PRESETS)) {
      for (const s of p.steps) expect(() => getStep(s.step), `${p.name}:${s.step}`).not.toThrow();
    }
  });
});

describe('inline plan resolution', () => {
  it('parses an assembled plan JSON and defaults select to inventory', () => {
    const plan = resolvePlan(
      JSON.stringify({
        name: 'adhoc',
        steps: [
          { step: 'provision', params: { osSlug: 'ubuntu-24.04', deploymentName: 'adhoc' } },
          { step: 'verify-os' },
          { step: 'end-rental', always: true },
        ],
      }),
    );
    expect(plan.name).toBe('adhoc');
    expect(plan.select).toBe('inventory');
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps.at(-1)?.always).toBe(true);
  });

  it('honors an explicit select', () => {
    expect(resolvePlan(JSON.stringify({ name: 'x', select: 'any', steps: [{ step: 'power-cycle' }] })).select).toBe(
      'any',
    );
  });
});

describe('validation failures (fail loud)', () => {
  it('rejects a spec that is neither a preset nor valid JSON', () => {
    expect(() => resolvePlan('not-a-preset')).toThrow(/neither a known preset.*nor valid plan JSON/s);
  });

  it('rejects an empty step list', () => {
    expect(() => validatePlan({ name: 'x', steps: [] })).toThrow(/non-empty array/);
  });

  it('rejects an unknown step id inside a plan', () => {
    expect(() => validatePlan({ name: 'x', steps: [{ step: 'frobnicate' }] })).toThrow(/unknown step 'frobnicate'/);
  });

  it('rejects a bad select value', () => {
    expect(() => validatePlan({ name: 'x', select: 'sideways', steps: [{ step: 'power-cycle' }] })).toThrow(
      /select must be/,
    );
  });
});
