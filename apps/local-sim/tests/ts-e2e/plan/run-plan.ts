/**
 * Plan executor — drives one assembled plan against one device.
 *
 * Selects the device once, runs the non-cleanup steps in order, then runs the
 * `always` (cleanup) steps in a `finally` so the device is returned to a clean
 * state even when a step fails. Each step is announced via `step()` so the
 * lab's live timeline / recorder picks it up the same way the monolithic
 * journeys did. The first failure is re-thrown after cleanup so vitest reports
 * the plan as failed.
 */

import { bootMacFromEnv, dataIpForDevice, explicitDeviceIdFromEnv, pollUntil } from '../helpers';
import { powerBmIntoDiscovery, selectAnyDevice, selectInventoryDevice, step } from '../lifecycle-helpers';
import { getStep } from './steps';
import type { Plan, PlanClients, PlanContext } from './types';

/** vitest's per-test `skip` (`({ skip }) => ...`). */
type SkipFn = (note?: string) => void;

export async function resolveDataIp(clients: PlanClients, deviceId: string): Promise<string> {
  const explicitId = explicitDeviceIdFromEnv();
  if (!explicitId) return dataIpForDevice(clients.fleet, deviceId);

  const bootMac = bootMacFromEnv();
  if (!bootMac) {
    throw new Error(
      'SIM_LC_DEVICE_ID is set (bare-metal mode) but SIM_LC_BOOT_MAC is not -- cannot resolve the data IP',
    );
  }

  // A bare-metal box populates eth0 IP + storageLayouts only from a live collection, and the
  // bridge auto-collect is on a 3600s cooldown; this endpoint is cooldown-agnostic and idempotent.
  step('forcing inventory collection on the bare-metal box...');
  const collectRes = await clients.hubAdmin.collectInventory(explicitId);
  if (collectRes.status !== 200 && collectRes.status !== 202) {
    throw new Error(`force-collect failed (${collectRes.status}): ${JSON.stringify(collectRes.body)}`);
  }

  // An open deployment makes chain serve render_disk, so the next PXE boots the installed OS.
  // Asserted, not awaited: the atom is rendered on demand at /api/chain, so a wait cannot converge.
  const bootOs = await clients.hubDb.getChainBootOs(explicitId);
  if (bootOs.installed !== null && bootOs.rescue === null) {
    throw new Error(
      `device ${explicitId} still has an open deployment (installed_os=${bootOs.installed}) -- ` +
        'the next PXE would boot the installed OS instead of brokkr-live; the pre-test reset should ' +
        'have closed it',
    );
  }

  // Only now boot the box into brokkr-live (boot-source PXE + power) so eth0 DHCPs and the
  // agent connects. Mirrors the production commission path.
  await powerBmIntoDiscovery(bootMac, explicitId);

  step(`waiting for bare-metal discovery to land (boot MAC ${bootMac})...`);
  // Wait for BOTH preconditions a VM gets from seed: the eth0 IpAddress row
  // (getDataIpByBootMac) AND non-empty Server.storageLayouts (provision's
  // buildProvisionPayload throws without it). Both are written by the same
  // collectAll -> discovery.complete -> applyMutations round-trip. 540s covers
  // boot-source -> power -> DHCP -> agent-connect -> collect_hardware ->
  // applyMutations; strictly more than awaitDiscoveryReady's 420s budget.
  const landed = await pollUntil(
    async () => {
      const ip = await clients.hubDb.getDataIpByBootMac(bootMac);
      const layouts = await clients.hubDb.getStorageLayouts(explicitId);
      const configs = layouts?.configs;
      const hasStorage = Array.isArray(configs) && configs.length > 0;
      return { ip, hasStorage };
    },
    (v) => v.ip !== null && v.hasStorage,
    { timeout: 540_000, interval: 10_000 },
  );
  if (!landed.ip || !landed.hasStorage) {
    throw new Error(
      `bare-metal discovery did not land for boot MAC ${bootMac} (device ${deviceId}): ` +
        `dataIp=${landed.ip ?? 'null'} hasStorageLayouts=${landed.hasStorage} after collection -- ` +
        'did collect_hardware persist (check the bridge for a NOPERM key-prefix drop)?',
    );
  }
  step(`bare-metal discovery landed; data IP: ${landed.ip}`);
  return landed.ip;
}

export async function runPlan(clients: PlanClients, plan: Plan, skip: SkipFn): Promise<void> {
  // Resolve step ids and validate params up front so a typo or bad param fails before we touch hardware.
  const resolved = plan.steps.map((ps) => {
    const s = getStep(ps.step);
    s.parseParams(ps.params);
    return { ps, step: s };
  });

  const selector = plan.select ?? 'inventory';
  const deviceId =
    selector === 'any'
      ? await selectAnyDevice(clients.hubDb, clients.fleet)
      : await selectInventoryDevice(clients.hubDb, clients.fleet);
  if (!deviceId) {
    skip(
      selector === 'inventory'
        ? 'no INVENTORY device available; reset one with end-rental first'
        : 'no devices seeded; run task sim:seed first',
    );
    return;
  }

  const dataIp = await resolveDataIp(clients, deviceId);
  const ctx: PlanContext = { ...clients, deviceId, dataIp, scratch: {} };
  step(`plan '${plan.name}' on device ${deviceId} (${resolved.length} steps)`);

  const cleanup = resolved.filter((r) => r.ps.always);
  let failure: unknown = null;
  try {
    for (const { ps, step: s } of resolved) {
      if (ps.always) continue; // deferred to the finally below
      step(`▶ ${s.label}`);
      await s.exec(ctx, ps.params);
    }
  } catch (err) {
    failure = err;
    // Surface WHY the plan failed now, before the cleanup steps run -- otherwise the
    // timeline only shows cleanup noise and the real error doesn't appear until vitest
    // re-throws it after cleanup (which can be a slow deprovision).
    step(`✗ step failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    for (const { ps, step: s } of cleanup) {
      step(`▶ cleanup: ${s.label}`);
      try {
        await s.exec(ctx, ps.params);
      } catch (err) {
        // A cleanup failure shouldn't mask the real failure; surface it but keep going.
        step(`cleanup step '${s.label}' failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  if (failure) throw failure;
}
