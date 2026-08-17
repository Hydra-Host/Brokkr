/**
 * Preset plans + plan resolution.
 *
 * Presets are the named, ready-made plans (the old monolithic journeys
 * re-expressed as step lists). `resolvePlan` accepts either a preset name or an
 * inline plan JSON string (what the lab/UI will pass via `SIM_PLAN`), so a
 * custom assembled plan and a preset run through the exact same path.
 */

import { getStep } from './steps';
import type { Plan, PlanStep } from './types';

export const PRESETS: Record<string, Plan> = {
  'lifecycle-quick': {
    name: 'lifecycle-quick',
    description: 'provision → end-rental',
    steps: [
      { step: 'provision', params: { deploymentName: 'e2e-quick' } },
      { step: 'end-rental', always: true },
    ],
  },
  'lifecycle-full': {
    name: 'lifecycle-full',
    description: 'provision → reprovision → power-cycle → end-rental',
    steps: [
      { step: 'provision', params: { deploymentName: 'e2e-full' } },
      { step: 'reprovision', params: { deploymentName: 'e2e-full-reprov' } },
      { step: 'power-cycle' },
      { step: 'end-rental', always: true },
    ],
  },
  // Single-pass analogs of the monolithic journeys. The matrix journeys
  // (base-os / disk-layout cycling N options) are expressed as assembled plans
  // with repeated provision→verify pairs, not as fixed presets.
  'base-os': {
    name: 'base-os',
    description: 'provision a base OS → verify distro/version → end-rental',
    steps: [
      { step: 'provision', params: { deploymentName: 'e2e-baseos' } },
      { step: 'verify-os' },
      { step: 'end-rental', always: true },
    ],
  },
  'disk-layout': {
    name: 'disk-layout',
    description: 'provision the seeded default disk layout → verify it on the booted OS → end-rental',
    steps: [
      { step: 'provision', params: { deploymentName: 'e2e-disklayout' } },
      { step: 'verify-disk' },
      { step: 'end-rental', always: true },
    ],
  },
  // Template: assembled plans supply real `customizations` on the provision step.
  layers: {
    name: 'layers',
    description: 'provision base + OS-customization layers → verify each layer → end-rental',
    steps: [
      { step: 'provision', params: { deploymentName: 'e2e-layers', customizations: {} } },
      { step: 'verify-layers' },
      { step: 'end-rental', always: true },
    ],
  },
  rescue: {
    name: 'rescue',
    description: 'provision → activate rescue (live OS) → exit rescue (installed OS) → end-rental',
    steps: [
      { step: 'provision', params: { deploymentName: 'e2e-rescue' } },
      { step: 'rescue-activate' },
      { step: 'rescue-deactivate' },
      { step: 'end-rental', always: true },
    ],
  },
  // Template: assembled plans supply the composed `cloudInit` on the provision step.
  'cloud-init': {
    name: 'cloud-init',
    description: 'provision with user-data → verify cloud-init sections → end-rental',
    steps: [
      { step: 'provision', params: { deploymentName: 'e2e-cloudinit' } },
      { step: 'verify-cloud-init' },
      { step: 'end-rental', always: true },
    ],
  },
  'custom-ipxe': {
    name: 'custom-ipxe',
    description: 'provision ipxe-custom + verify the stored iPXE URL → end-rental',
    steps: [{ step: 'provision-ipxe-custom' }, { step: 'end-rental', always: true }],
  },
  // Spoke HA: each step fires a provision then disrupts the working spoke mid-saga.
  // Requires >=2 HA spoke replicas (the step throws otherwise).
  'spoke-failover': {
    name: 'spoke-failover',
    description: 'provision → kill the working spoke → a survivor finishes → end-rental',
    steps: [{ step: 'spoke-failover' }, { step: 'end-rental', always: true }],
  },
  'spoke-resume': {
    name: 'spoke-resume',
    description: 'provision → restart the working spoke → saga resumes → end-rental',
    steps: [{ step: 'spoke-resume' }, { step: 'end-rental', always: true }],
  },
};

function validatePlanStep(raw: unknown, i: number): PlanStep {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`plan.steps[${i}] must be an object`);
  }
  const r: Record<string, unknown> = { ...raw };
  if (typeof r.step !== 'string' || !r.step) throw new Error(`plan.steps[${i}].step must be a non-empty string`);
  getStep(r.step); // throws (with the known-ids list) if the step doesn't exist
  if (r.always !== undefined && typeof r.always !== 'boolean') {
    throw new Error(`plan.steps[${i}].always must be a boolean`);
  }
  return { step: r.step, params: r.params, always: r.always === true };
}

/** Validate an arbitrary parsed object into a Plan (used for inline/assembled plans). */
export function validatePlan(raw: unknown): Plan {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('plan must be an object');
  const r: Record<string, unknown> = { ...raw };
  if (typeof r.name !== 'string' || !r.name) throw new Error('plan.name must be a non-empty string');
  if (!Array.isArray(r.steps) || r.steps.length === 0) throw new Error('plan.steps must be a non-empty array');
  if (r.select !== undefined && r.select !== 'inventory' && r.select !== 'any') {
    throw new Error("plan.select must be 'inventory' or 'any'");
  }
  return {
    name: r.name,
    description: typeof r.description === 'string' ? r.description : undefined,
    select: r.select === 'any' ? 'any' : 'inventory',
    steps: r.steps.map(validatePlanStep),
  };
}

/** Resolve a `SIM_PLAN` value: a preset name, or an inline plan JSON string. */
export function resolvePlan(spec: string): Plan {
  const trimmed = spec.trim();
  if (PRESETS[trimmed]) return PRESETS[trimmed];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `SIM_PLAN '${trimmed}' is neither a known preset (${Object.keys(PRESETS).join(', ')}) nor valid plan JSON`,
    );
  }
  return validatePlan(parsed);
}
