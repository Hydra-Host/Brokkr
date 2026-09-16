/**
 * Shared lifecycle E2E helpers (TypeScript port of test_lifecycle.py procedures).
 *
 * Drive a seeded device through the real sagas via the Hub admin API, asserting
 * that the two Hub-Postgres lifecycle axes and the bridge device-record atom move
 * in lockstep -- the core "verify atoms + DB along the lifecycle" check.
 *
 * This module is deliberately NOT a `*.test.ts` file: it declares no `describe`/
 * `it`, only exported helpers. The modular plan engine (`plan/steps.ts`) and the
 * remaining scenario suites import these helpers from HERE; keeping them out of a
 * test file means importing them never executes a stray top-level `describe`.
 */

import { execFile } from 'node:child_process';
import * as net from 'node:net';
import { promisify } from 'node:util';
import { expect } from 'vitest';

import { BridgeRedis } from './bridge-redis';
import {
  buildProvisionPayload,
  explicitDeviceIdFromEnv,
  pollUntil,
  simDeviceUuid,
  type DiskLayoutSelection,
  type Fleet,
} from './helpers';
import { HubAdminClient } from './hub-client';
import { HubDB } from './hub-db';
import { VMClient, userForSlug } from './vm-client';

export { loadFleet } from './helpers';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function step(
  msg: string,
  opts?: { source?: string; level?: string; metadata?: Record<string, unknown> },
): void {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  console.log(`  [${ts}] ${msg}`);

  const eventsUrl = process.env.TEST_EVENTS_URL;
  if (eventsUrl) {
    fetch(eventsUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: opts?.source ?? 'test',
        level: opts?.level ?? 'info',
        message: msg,
        metadata: opts?.metadata,
      }),
    }).catch(() => {});
  }
}

/** Stable slug from the seeded OS catalog; overridable via SIM_LC_BASE. */
export const OS_SLUG = process.env.SIM_LC_BASE?.trim() || 'ubuntu-24.04';

const QUICK_STEP_VALUES = ['provision', 'deprovision'] as const;
type QuickStep = (typeof QUICK_STEP_VALUES)[number];

// ---------------------------------------------------------------------------
// Bare-metal discovery drive
// ---------------------------------------------------------------------------

const execFileP = promisify(execFile);

/**
 * Set PXE boot-source + power the bare-metal box into brokkr-live so discovery
 * runs and `getDataIpByBootMac` resolves.
 *
 * Shells out to `python -m local.bm_power <bootMac> <expectedUuid> --boot-live`
 * with an argv array (never `sh -c`) — both args are validated env values passed
 * as distinct elements, closing shell injection regardless of upstream checks.
 *
 * ARGV ORDER IS LOAD-BEARING: positional 1 = bootMac (resolves the node),
 * positional 2 = expectedUuid (the wrong-machine guard). A swap would hand the
 * MAC to the guard as the expected uuid and the guard would then reject every
 * run. The CLI's positional contract is asserted in
 * `tests/test_bm_power.py::test_cli_positional_contract_node_then_uuid`.
 *
 * `expectedUuid` is the wrong-machine guard: bm_power refuses to touch a box
 * whose derived uuid differs. `--boot-live` is power-state-aware (off→on,
 * on→reset). `--wait-ip` is deliberately omitted — run-plan.ts keeps its own TS
 * poll of the hub DB. The process `timeout` is sized to the IPMI-fallback worst
 * case (see BM_POWER_TIMEOUT_MS) so Node never SIGKILLs a BMC mid-sequence —
 * which would surface the very opaque exit-1 we're fixing.
 */
// bm_power's IPMI fallback with action="auto" runs 3 sequential ipmitool calls (status +
// set-bootdev + power), each bounded by bm_power's 60s per-request cap = 180s worst case; pad to
// 210s so Node never SIGKILLs a BMC that would still eventually succeed.
const BM_POWER_TIMEOUT_MS = 210_000;

// a VM is back on sshd inside a minute; a real box re-POSTs, re-inits its BMC and walks firmware
// device discovery first, so bare metal gets 15 minutes before a missing OS is called a failure.
export const VM_OS_RETURN_TIMEOUT_MS = 240_000;
export const BM_OS_RETURN_TIMEOUT_MS = 900_000;

export function osReturnTimeoutMs(bareMetal: boolean): number {
  return bareMetal ? BM_OS_RETURN_TIMEOUT_MS : VM_OS_RETURN_TIMEOUT_MS;
}

export async function powerBmIntoDiscovery(bootMac: string, expectedUuid: string): Promise<void> {
  step(`bare-metal: setting PXE boot + powering box into brokkr-live for discovery (${bootMac})...`);
  try {
    // argv order: bootMac (node), then expectedUuid (guard) — see JSDoc above.
    await execFileP('python', ['-m', 'local.bm_power', bootMac, expectedUuid, '--boot-live'], {
      env: process.env,
      timeout: BM_POWER_TIMEOUT_MS,
    });
  } catch (err) {
    const stderr = err !== null && typeof err === 'object' && 'stderr' in err ? String(err.stderr) : '';
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`bm_power failed to boot ${bootMac} into brokkr-live: ${msg}${stderr ? `\n${stderr}` : ''}`);
  }
}

// ---------------------------------------------------------------------------
// Serial console log path
// ---------------------------------------------------------------------------

export function serialLogFor(deviceId: string, fleet: Fleet): string | null {
  const logDir = process.env.LOCAL_STATE
    ? `${process.env.LOCAL_STATE}/logs`
    : `${process.env.HOME}/.local/share/local/state/logs`;
  for (let i = 0; i < fleet.nodes.length; i++) {
    if (simDeviceUuid(i) === deviceId) {
      return `${logDir}/${fleet.nodes[i]!.name}.log`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Device selectors
// ---------------------------------------------------------------------------

export async function firstDeviceWithLifecycle(hubDb: HubDB, fleet: Fleet, status: string): Promise<string | null> {
  for (let i = 0; i < fleet.nodes.length; i++) {
    const deviceId = simDeviceUuid(i);
    const state = await hubDb.getServerState(deviceId);
    if (state.lifecycleStatus === status) {
      return deviceId;
    }
  }
  return null;
}

/**
 * Pick the device this run drives. `SIM_LC_DEVICE_ID` pins a bare-metal box;
 * `SIM_LC_DEVICE_INDEX` pins a VM node so parallel runs don't race on
 * first-INVENTORY selection (the pick->PROVISIONING flip is not atomic); either
 * pinned device must be INVENTORY or the run skips. Unset = first INVENTORY.
 */
export async function selectInventoryDevice(hubDb: HubDB, fleet: Fleet): Promise<string | null> {
  const explicitId = explicitDeviceIdFromEnv();
  if (explicitId) {
    const state = await hubDb.getServerState(explicitId);
    return state.lifecycleStatus === 'INVENTORY' ? explicitId : null;
  }
  const pinned = process.env.SIM_LC_DEVICE_INDEX;
  if (pinned !== undefined && pinned !== '') {
    const deviceId = simDeviceUuid(parseInt(pinned, 10));
    const state = await hubDb.getServerState(deviceId);
    return state.lifecycleStatus === 'INVENTORY' ? deviceId : null;
  }
  return firstDeviceWithLifecycle(hubDb, fleet, 'INVENTORY');
}

/**
 * Parse SIM_LC_STEPS into the set of quick-lifecycle steps to run.
 *
 * Unset or empty = both steps. Comma-separated subset otherwise. Throws on
 * unknown step names.
 */
export function parseQuickSteps(): Set<QuickStep> {
  const raw = (process.env.SIM_LC_STEPS ?? '').trim();
  if (!raw) {
    return new Set(QUICK_STEP_VALUES);
  }
  const picked = new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (picked.size === 0) {
    throw new Error(
      `SIM_LC_STEPS=${process.env.SIM_LC_STEPS} parsed to no steps ` +
        `(known: ${JSON.stringify([...QUICK_STEP_VALUES])})`,
    );
  }
  const known = new Set<string>(QUICK_STEP_VALUES);
  const unknown = [...picked].filter((s) => !known.has(s));
  if (unknown.length > 0) {
    throw new Error(
      `SIM_LC_STEPS has unknown step(s): ${JSON.stringify(unknown.sort())} ` +
        `(known: ${JSON.stringify([...QUICK_STEP_VALUES])})`,
    );
  }
  return picked as Set<QuickStep>;
}

/**
 * Deprovision-only picker: pinned wins, else prefer non-INVENTORY (deprovision on
 * INVENTORY is a no-op), else fall back to the first device.
 */
export async function selectAnyDevice(hubDb: HubDB, fleet: Fleet): Promise<string | null> {
  const explicitId = explicitDeviceIdFromEnv();
  if (explicitId) return explicitId;
  const pinned = process.env.SIM_LC_DEVICE_INDEX;
  if (pinned !== undefined && pinned !== '') {
    return simDeviceUuid(parseInt(pinned, 10));
  }
  for (let i = 0; i < fleet.nodes.length; i++) {
    const deviceId = simDeviceUuid(i);
    const state = await hubDb.getServerState(deviceId);
    if (state.lifecycleStatus && state.lifecycleStatus !== 'INVENTORY') {
      return deviceId;
    }
  }
  return simDeviceUuid(0);
}

// ---------------------------------------------------------------------------
// SSH port probe + sleep
// ---------------------------------------------------------------------------

/** Check whether TCP port 22 is reachable on the given IP. */
async function sshPortOpen(ip: string, timeout = 4000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeout);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(22, ip);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Lifecycle step helpers (exported for reuse by other test files)
// ---------------------------------------------------------------------------

/**
 * Block until the device's brokkr-bridge-agent is active in brokkr-live.
 *
 * **provision** (`hubDb` omitted): a clean, non-racy gate run BEFORE firing --
 * the box already sits in brokkr-live in INVENTORY and the provision saga
 * deploys in-place, so it must have a connected agent first.
 *
 * **reprovision** (`hubDb` passed): run AFTER firing to confirm the saga
 * re-enters brokkr-live for its redeploy. But that brokkr-live window is
 * transient -- by the time we poll the saga may already be wiping/installing
 * or back on the customer OS, so requiring "agent active right now" would
 * flake. Treat any forward progress as success: brokkr-live agent active, the
 * customer OS already reachable, or the hub already at PROVISIONED.
 */
export async function awaitDiscoveryReady(
  dataIp: string,
  deviceId: string,
  opts?: { timeout?: number; hubDb?: HubDB; slug?: string },
): Promise<void> {
  const timeout = opts?.timeout ?? 420_000;
  const slug = opts?.slug ?? OS_SLUG;
  const ip = dataIp;
  const live = new VMClient(ip, 'root');

  step(`awaiting discovery ready on ${ip} (brokkr-live agent active)...`);
  const ready = await pollUntil(
    async () => {
      try {
        if (await live.systemctlActive('brokkr-bridge-agent')) {
          return true;
        }
      } catch {
        // SSH connection failure -- keep polling
      }
      if (opts?.hubDb) {
        const state = await opts.hubDb.getServerState(deviceId);
        if (state.lifecycleStatus === 'PROVISIONED') return true;
        const osVm = new VMClient(ip, userForSlug(slug));
        const result = await osVm.run('true');
        if (result.returncode === 0) return true;
      }
      return false;
    },
    (r) => r === true,
    { timeout, interval: 10_000 },
  );

  expect(
    ready,
    `device ${deviceId} never reached brokkr-live with an active agent (nor made any ` +
      `forward progress) within ${timeout}ms -- provision would boot the disk and hang ` +
      `on wait_for_agent_session`,
  ).toBe(true);
}

/**
 * Fire provision/reprovision and assert PROVISIONING (+ atom lockstep) -> PROVISIONED.
 *
 * `osSlug` selects the base OS (defaults to the lifecycle OS_SLUG);
 * `customizations` adds the OS-layer stack (layer test); `cloudInit` adds
 * user-data (cloud-init test).
 *
 * Returns the job ID from the device record atom's `last_job_id`.
 */
export async function awaitProvisioned(
  hubAdmin: HubAdminClient,
  hubDb: HubDB,
  bridgeRedis: BridgeRedis,
  dataIp: string,
  deviceId: string,
  opts: {
    kind: 'provision' | 'reprovision';
    deploymentName: string;
    osSlug?: string;
    customizations?: Record<string, string | string[]>;
    cloudInit?: string | Record<string, unknown>;
    ipxeUrl?: string;
    diskLayout?: DiskLayoutSelection;
  },
): Promise<string> {
  const osSlug = opts.osSlug ?? OS_SLUG;

  step(`--- ${opts.kind} (${osSlug}, "${opts.deploymentName}") ---`);
  if (opts.kind === 'provision') {
    await awaitDiscoveryReady(dataIp, deviceId, { slug: osSlug });
  }

  step(`building payload + firing ${opts.kind}...`);
  const payload = await buildProvisionPayload(hubDb, deviceId, {
    osSlug,
    deploymentName: opts.deploymentName,
    customizations: opts.customizations,
    cloudInit: opts.cloudInit,
    ipxeUrl: opts.ipxeUrl,
    diskLayout: opts.diskLayout,
  });

  let response: Awaited<ReturnType<typeof hubAdmin.provision>>;
  if (opts.kind === 'reprovision') {
    const depId = await hubDb.getActiveDeploymentId(deviceId);
    expect(depId, `no active deployment for ${deviceId} -- cannot reprovision`).toBeTruthy();
    response = await hubAdmin.reprovision(depId!, { ...payload });
  } else {
    response = await hubAdmin.provision(deviceId, { ...payload });
  }
  expect(response.status, `${opts.kind} rejected: ${JSON.stringify(response.body)}`).toBe(200);
  step(`${opts.kind} accepted, awaiting PROVISIONING in DB...`);

  const provisioningState = await pollUntil(
    () => hubDb.getServerState(deviceId),
    (s) => s.lifecycleStatus === 'PROVISIONING',
    { timeout: 60_000, interval: 3_000 },
  );
  expect(
    provisioningState.lifecycleStatus,
    `${opts.kind} did not enter PROVISIONING: ${JSON.stringify(provisioningState)}`,
  ).toBe('PROVISIONING');
  step('PROVISIONING confirmed, awaiting atom lockstep (device record + job ID)...');

  const record = await pollUntil(
    () => bridgeRedis.getDeviceRecord(deviceId),
    (r) => r !== null && r.status === 'PROVISIONING' && Boolean(r.last_job_id),
    { timeout: 60_000, interval: 3_000 },
  );
  expect(record).not.toBeNull();
  expect(record!.status).toBe('PROVISIONING');
  const jobId = record!.last_job_id as string;
  step(`atom lockstep confirmed (job=${jobId})`);

  if (opts.kind === 'reprovision') {
    await awaitDiscoveryReady(dataIp, deviceId, { hubDb, slug: osSlug });
  }

  step('awaiting terminal state (PROVISIONED or FAILED)...');
  const finalState = await pollUntil(
    () => hubDb.getServerState(deviceId),
    (s) => s.lifecycleStatus === 'PROVISIONED' || s.lifecycleStatus === 'FAILED' || s.lifecycleStatus === 'INVENTORY',
    { timeout: 900_000, interval: 15_000 },
  );
  expect(
    finalState.lifecycleStatus,
    `${opts.kind} ended in ${finalState.lifecycleStatus} (expected PROVISIONED) — ` +
      (finalState.lifecycleStatus === 'INVENTORY'
        ? 'saga failed and recovery reset the device to INVENTORY'
        : `saga reported ${finalState.lifecycleStatus}`),
  ).toBe('PROVISIONED');
  step(`${opts.kind} complete -> PROVISIONED`);

  return jobId;
}

/**
 * Classify what OS the VM is running by SSH probe.
 *
 * - `'os'` -- the installed customer OS (ubuntu auth succeeds)
 * - `'brokkr-live'` -- discovery image (ubuntu denied, root succeeds)
 * - `'down'` -- SSH port not open (powered off / still booting)
 * - `'unknown'` -- port open but neither user authenticates
 *
 * sshd often binds :22 a beat before it can accept auth/exec, so after the
 * port opens we settle 1s, then retry the auth probe 3x (1s apart) to ride
 * out the just-booted window. A device is only ever one of os/brokkr-live, so
 * each attempt tries both users.
 */
export async function classifyBoot(ip: string, slug: string = OS_SLUG): Promise<string> {
  if (!(await sshPortOpen(ip))) {
    return 'down';
  }
  await sleep(1_000);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(1_000);
    const osResult = await new VMClient(ip, userForSlug(slug)).run('true');
    if (osResult.returncode === 0) return 'os';
    const liveResult = await new VMClient(ip, 'root').run('true');
    if (liveResult.returncode === 0) return 'brokkr-live';
  }
  return 'unknown';
}

export interface PowerCycleOptions {
  /** Bare-metal target -- the run's device selection, not the fleet plane (a mixed stack has both). */
  bareMetal?: boolean;
  /** Read only once a wait has already failed, and never allowed to fail the step. */
  bootTrail?: () => Promise<string | null>;
}

async function osReturnFailureSuffix(
  state: string,
  startedAtMs: number,
  bootTrail?: () => Promise<string | null>,
): Promise<string> {
  const elapsedSeconds = Math.round((Date.now() - startedAtMs) / 1_000);
  let trail: string | null = null;
  try {
    trail = (await bootTrail?.()) ?? null;
  } catch (error) {
    trail = `unreadable (${error instanceof Error ? error.message : String(error)})`;
  }
  return ` -- last state '${state}', ${elapsedSeconds}s elapsed, boot trail: ${trail ?? 'unavailable'}`;
}

/**
 * Reboot the PROVISIONED device and require it back as the INSTALLED OS.
 *
 * A boot into brokkr-live (root SSH, no ubuntu) is a real failure -- it means
 * /api/chain routed to discovery because the device_record atom never advanced
 * to PROVISIONED. The device must already be in the installed OS going in; we
 * reboot via the hub and require it to return as the same OS with a changed
 * boot_id.
 */
export async function powerCycle(
  hubAdmin: HubAdminClient,
  hubDb: HubDB,
  dataIp: string,
  deviceId: string,
  opts: PowerCycleOptions = {},
): Promise<void> {
  const ip = dataIp;

  step('--- power-cycle ---');
  step(`confirming installed OS on ${ip}...`);
  const preBootStartedAt = Date.now();
  const preBoot = await pollUntil(
    () => classifyBoot(ip),
    (s) => s === 'os' || s === 'brokkr-live',
    { timeout: osReturnTimeoutMs(opts.bareMetal ?? false), interval: 10_000 },
  );
  const preBootSuffix = preBoot === 'os' ? '' : await osReturnFailureSuffix(preBoot, preBootStartedAt, opts.bootTrail);
  expect(
    preBoot,
    `device ${deviceId} is running '${preBoot}', not the installed OS, before power-cycle -- ` +
      `provisioning never booted the OS (device_record atom stuck pre-PROVISIONED -> ` +
      `chain -> brokkr-live)${preBootSuffix}`,
  ).toBe('os');

  const osVm = new VMClient(ip, userForSlug(OS_SLUG));
  const beforeResult = await osVm.run('cat /proc/sys/kernel/random/boot_id');
  const before = beforeResult.stdout.trim();

  const depId = await hubDb.getActiveDeploymentId(deviceId);
  expect(depId, `no active deployment for ${deviceId} -- cannot reboot`).toBeTruthy();
  step('firing reboot via hub API...');
  const response = await hubAdmin.reboot(depId!);
  expect(response.status, `reboot rejected: ${JSON.stringify(response.body)}`).toBe(200);

  step('awaiting fresh boot (new boot_id on installed OS)...');
  const rebootStartedAt = Date.now();
  const probeResult = await pollUntil(
    async () => {
      const st = await classifyBoot(ip);
      let boot = '';
      if (st === 'os') {
        const bootResult = await osVm.run('cat /proc/sys/kernel/random/boot_id');
        boot = bootResult.stdout.trim();
      }
      return { st, boot };
    },
    (r) => (r.st === 'os' && r.boot !== '' && r.boot !== before) || r.st === 'brokkr-live',
    { timeout: osReturnTimeoutMs(opts.bareMetal ?? false), interval: 10_000 },
  );

  expect(
    probeResult.st,
    `device ${deviceId} rebooted into brokkr-live, not the installed OS -- ` +
      `device_record atom not re-published on PROVISIONED`,
  ).not.toBe('brokkr-live');
  const rebootSuffix =
    probeResult.st === 'os' ? '' : await osReturnFailureSuffix(probeResult.st, rebootStartedAt, opts.bootTrail);
  expect(probeResult.st, `device ${deviceId} never came back as the installed OS after reboot${rebootSuffix}`).toBe(
    'os',
  );
  expect(probeResult.boot).toBeTruthy();
  expect(
    probeResult.boot,
    `device ${deviceId} did not return as the installed OS after reboot ` +
      `(state=${probeResult.st}, boot_id=${probeResult.boot || 'none'})`,
  ).not.toBe(before);

  const state = await hubDb.getServerState(deviceId);
  expect(state.lifecycleStatus, `power-cycle left lifecycle at ${state.lifecycleStatus}`).toBe('PROVISIONED');
  step('power-cycle complete -> still PROVISIONED');
}

/**
 * Drive a device to INVENTORY, picking the right admin call per device state:
 * end-rental when an active deployment exists (closes it AND decoms),
 * standalone deprovision otherwise. Probing avoids the 404 you get hitting
 * raw /deprovision on a device with a dangling Deployment row (e.g. left
 * PROVISIONED by an earlier provision-only quick-lifecycle run).
 */
export async function endRentalToInventory(hubAdmin: HubAdminClient, hubDb: HubDB, deviceId: string): Promise<void> {
  step('--- end-rental -> INVENTORY ---');
  const depId = await hubDb.getActiveDeploymentId(deviceId);
  if (!depId) {
    const state = await hubDb.getServerState(deviceId);
    if (state.lifecycleStatus === 'INVENTORY') {
      step('already INVENTORY, skipping');
      return;
    }
    // No active deployment and not INVENTORY -- cannot deprovision; warn and return
    console.warn(
      `no active deployment for ${deviceId} and not INVENTORY ` + `(${state.lifecycleStatus}) -- cannot deprovision`,
    );
    return;
  }

  step(`firing end-rental (deployment=${depId})...`);
  const response = await hubAdmin.endRental(depId);
  expect(response.status, `end-rental rejected: ${JSON.stringify(response.body)}`).toBe(200);

  step('awaiting DEPROVISIONING...');
  const decomState = await pollUntil(
    () => hubDb.getServerState(deviceId),
    (s) => s.lifecycleStatus === 'DEPROVISIONING' || s.lifecycleStatus === 'INVENTORY',
    { timeout: 60_000, interval: 3_000 },
  );
  expect(['DEPROVISIONING', 'INVENTORY'], `deprovision did not start: ${JSON.stringify(decomState)}`).toContain(
    decomState.lifecycleStatus,
  );
  step(`deprovision started (${decomState.lifecycleStatus}), awaiting INVENTORY...`);

  const finalState = await pollUntil(
    () => hubDb.getServerState(deviceId),
    (s) => s.lifecycleStatus === 'INVENTORY',
    { timeout: 900_000, interval: 15_000 },
  );
  expect(finalState.lifecycleStatus, `reset ended in ${finalState.lifecycleStatus} (expected INVENTORY)`).toBe(
    'INVENTORY',
  );
  step('end-rental complete -> INVENTORY');
}
