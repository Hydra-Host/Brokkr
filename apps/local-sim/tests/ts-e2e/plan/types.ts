/**
 * Modular test-plan contract.
 *
 * A test PLAN is an ordered list of STEPS run against a single device with one
 * shared setup/teardown. Each step is a self-contained building block (an
 * action like `provision`, or a verification like `verify-os`) registered in
 * `./steps`. Presets (the old monolithic journeys) are just named plans.
 *
 * This replaces firing N scenarios one-by-one: assemble the steps you want into
 * one plan and run the whole thing on one device acquisition / one OS deploy.
 */

import type { BridgeRedis } from '../bridge-redis';
import type { Fleet } from '../helpers';
import type { HubAdminClient } from '../hub-client';
import type { HubDB } from '../hub-db';

/** The session-level clients a plan run shares across every step. */
export interface PlanClients {
  hubAdmin: HubAdminClient;
  hubDb: HubDB;
  bridgeRedis: BridgeRedis;
  fleet: Fleet;
}

/**
 * Per-run context handed to every step.
 *
 * `scratch` is the seam that lets steps pass data the way a monolithic test
 * shared locals: e.g. `provision` records the OS slug it deployed and
 * `verify-os` reads it back to know what to assert.
 */
export interface PlanContext extends PlanClients {
  /** The single device this plan run drives (selected once at plan start). */
  deviceId: string;
  dataIp: string;
  /** Cross-step scratch space (e.g. last job id, the OS slug just provisioned). */
  scratch: Record<string, unknown>;
}

/**
 * One assemblable building block.
 *
 * `parseParams` validates/normalizes the plan-supplied params (external JSON)
 * before `run` sees them, so a malformed plan fails with a clear message rather
 * than a downstream type error. `run` asserts with vitest `expect`; a throw
 * fails the step (and the plan).
 */
export interface Step<P = void> {
  id: string;
  label: string;
  parseParams(raw: unknown): P;
  run(ctx: PlanContext, params: P): Promise<void>;
}

/** A step as it appears inside a plan. */
export interface PlanStep {
  /** A registered `Step.id`. */
  step: string;
  /** Raw params, validated by the step's `parseParams`. */
  params?: unknown;
  /**
   * Cleanup steps (e.g. `end-rental`) marked `always` run in a `finally` even
   * when an earlier step threw — mirroring the per-journey cleanup the
   * monolithic tests did. They run after all non-cleanup steps, in listed order.
   */
  always?: boolean;
}

/** How a plan picks the device it drives. */
export type DeviceSelector = 'inventory' | 'any';

/** An ordered, assemblable test plan. Presets are just named plans. */
export interface Plan {
  name: string;
  description?: string;
  /** Default `'inventory'` (first INVENTORY device, or the `SIM_LC_DEVICE_INDEX` pin). */
  select?: DeviceSelector;
  steps: PlanStep[];
}
