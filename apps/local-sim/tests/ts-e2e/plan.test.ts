/**
 * Modular test-plan entry point.
 *
 * Runs ONE assembled plan, selected via the `SIM_PLAN` env var:
 *   - a preset name        (e.g. `SIM_PLAN=lifecycle-full`)
 *   - or an inline plan JSON (what the lab's `plan-custom` scenario passes)
 * Defaults to `lifecycle-full` when unset.
 *
 * This is the single seam the lab/UI drives: assemble steps → set SIM_PLAN →
 * run this file. The session-level clients + recorder are wired here once
 * (matching the monolithic journeys), and `runPlan` executes the steps.
 */

import { afterAll, beforeAll, describe, it } from 'vitest';

import { BridgeRedis } from './bridge-redis';
import { type Fleet } from './helpers';
import { HubAdminClient } from './hub-client';
import { HubDB } from './hub-db';
import { loadFleet } from './lifecycle-helpers';
import { LifecycleRecorder } from './lifecycle-recorder';
import { resolvePlan } from './plan/presets';
import { runPlan } from './plan/run-plan';

const plan = resolvePlan(process.env.SIM_PLAN ?? 'lifecycle-full');

describe(`plan: ${plan.name}`, () => {
  let hubAdmin: HubAdminClient;
  let hubDb: HubDB;
  let bridgeRedis: BridgeRedis;
  let fleet: Fleet;
  let recorder: LifecycleRecorder;

  beforeAll(async () => {
    fleet = loadFleet();
    hubAdmin = new HubAdminClient();
    await hubAdmin.signIn();
    hubDb = HubDB.fromEnv();
    bridgeRedis = BridgeRedis.fromEnv();
    recorder = new LifecycleRecorder();
    await recorder.start();
  });

  afterAll(async () => {
    await recorder?.stop();
    await hubDb?.prisma.$disconnect();
    await bridgeRedis?.disconnect();
  });

  it(plan.description ?? plan.name, { timeout: 60 * 60 * 1000 }, async ({ skip }) => {
    await runPlan({ hubAdmin, hubDb, bridgeRedis, fleet }, plan, skip);
  });
});
