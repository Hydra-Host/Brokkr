/**
 * Device commissioning E2E -- drive the full real commissioning lifecycle from the
 * control-center / app perspective, with two seams handled per the sim's
 * reality:
 *
 * - **Network scan = REAL.** `scanNetwork` enqueues a real `network_scan`
 *   saga; the bridge nmaps the sim BMC plane (ipmi_sim/sushy are real responders on
 *   192.168.105.0/24). We poll the bridge-side Redis result key for completeness
 *   (the hub's `pollNetworkScan` 500s in sim on its NetBox dedup).
 * - **iPXE -> IPMI -> Redis enrichment = FAKE.** It can never arrive from real
 *   iPXE in this local setup, so we `HSET` the `{zone}:discovery:pending:{mac}`
 *   hash the hub's `enrichWithPendingDeviceData` merges into scanned devices by
 *   MAC.
 *
 * Commissioning itself is driven via `commissionDiscoveredDevice` (resolves a seeded
 * Device by its `Device.id` -- flips `Device.status=STAGED` and enqueues the
 * `commission` saga). The hub's qualify auto-orchestration -- gated on the device
 * still being a role=null commissioning record (`isQualifyDevice`),
 * the `DeviceCommissioningProgress` table having been removed -- then runs commission
 * (wipe + collect) -> discovery.complete -> qualify provision (real OS deploy,
 * `ubuntu-noble-vanilla`) -> phone-home provisioned -> deprovision (wipe) ->
 * `promoteQualifyDevice`, which sets `Server.lifecycleStatus=INVENTORY`.
 *
 * Completion predicate = `Server.lifecycleStatus == 'INVENTORY'`. The device is
 * left **commissioned** (no reset/teardown) -- it lands in INVENTORY as part of
 * inventory.
 *
 * Slowest scenario in the suite (commission wipe + full OS deploy + deprovision wipe) --
 * hence the generous terminal timeout. Auth is the hardcoded sim admin.
 *
 * CURRENTLY DISABLED: the network scan step requires admin-only endpoints
 * (scanNetwork / pollNetworkScan) that are not yet available on the main Hub
 * API. Once those endpoints are ported, remove the `.skip` and the TODO stubs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BridgeRedis } from './bridge-redis';
import { effectiveNodeIp, loadFleet, nodeSerial, pollUntil, simDeviceUuid, type Fleet } from './helpers';
import { HubAdminClient } from './hub-client';
import { HubDB } from './hub-db';
import { selectInventoryDevice } from './lifecycle-helpers';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** The BMC OOB plane the sim's ipmi_sim/sushy bind on; the real nmap scan runs here. */
const BMC_SUBNET = '192.168.105.0/24';

// ---------------------------------------------------------------------------
// TODO stubs for admin-only endpoints not yet on the main API
// ---------------------------------------------------------------------------

/**
 * Placeholder for `hubAdmin.scanNetwork(zoneId, subnets)`.
 *
 * The Python client's `scan_network` throws `NotImplementedError`; the TS
 * HubAdminClient doesn't have this method. Once the admin scanNetwork endpoint
 * is available on the main API, implement this and remove the skip.
 */
function scanNetwork(
  _hubAdmin: HubAdminClient,
  _zoneId: string,
  _subnets: string[],
): Promise<{ status: number; body: Record<string, unknown> }> {
  throw new Error(
    'scanNetwork is not yet available on the main Hub API -- ' +
      'this test is skipped until the admin endpoint is ported',
  );
}

/**
 * Placeholder for `hubAdmin.pollNetworkScan(planId)`.
 *
 * Same situation as scanNetwork: admin-only, not on the main API yet.
 */
function pollNetworkScan(
  _hubAdmin: HubAdminClient,
  _planId: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  throw new Error(
    'pollNetworkScan is not yet available on the main Hub API -- ' +
      'this test is skipped until the admin endpoint is ported',
  );
}

// ---------------------------------------------------------------------------
// Test suite (SKIPPED -- admin endpoints not available)
// ---------------------------------------------------------------------------

// Entire suite is skipped because the network scan step depends on admin-only
// endpoints (scanNetwork / pollNetworkScan) that don't exist on the main Hub
// API yet. Remove `.skip` once those are ported.
describe.skip('commissioning', () => {
  let hubAdmin: HubAdminClient;
  let hubDb: HubDB;
  let bridgeRedis: BridgeRedis;
  let fleet: Fleet;

  beforeAll(async () => {
    fleet = loadFleet();
    hubDb = HubDB.fromEnv();
    bridgeRedis = BridgeRedis.fromEnv();
    hubAdmin = new HubAdminClient();
    await hubAdmin.signIn();
  });

  afterAll(async () => {
    await hubDb.prisma.$disconnect();
    await bridgeRedis.disconnect();
  });

  it('network scan + fake enrichment + commission saga -> qualify -> inventory', async () => {
    // ------------------------------------------------------------------
    // 0. Select an INVENTORY device
    // ------------------------------------------------------------------
    const deviceId = await selectInventoryDevice(hubDb, fleet);
    if (!deviceId) {
      console.warn('no INVENTORY device available; reset one with end-rental first');
      return;
    }

    const idx = fleet.nodes.findIndex((_n, i) => simDeviceUuid(i) === deviceId);
    expect(idx, `device ${deviceId} not found in fleet`).toBeGreaterThanOrEqual(0);

    const node = fleet.nodes[idx]!;
    const ipmiMac = node.ipmi_mac;
    const dataMac = node.data_mac;
    const dataIp = effectiveNodeIp(node, fleet.network.cidr, idx);
    const serial = nodeSerial(node.ipmi_mac);

    const { id, zoneId } = await hubDb.getDeviceIdentityAndZone(deviceId);
    expect(id, `device ${deviceId} has no id -- commission resolves by device id`).not.toBeNull();
    expect(zoneId, `device ${deviceId} has no zoneId`).toBeTruthy();

    // ------------------------------------------------------------------
    // 1. Device prep: there's no DeviceCommissioningProgress row
    //    to insert -- the qualify progression is gated on the device still
    //    being a role=null commissioning record (`isQualifyDevice`).
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 2. FAKE the iPXE -> IPMI -> Redis enrichment seam (joined by MAC
    //    on poll).
    // ------------------------------------------------------------------
    console.log('[commissioning] step: fake enrichment -- write discovery:pending hash');
    const key = await bridgeRedis.writeDiscoveryPending({
      ipmiMac,
      dataMac,
      dataIp,
      serial,
    });
    expect(key).toMatch(new RegExp(`${ipmiMac.replace(/:/g, '')}$`));

    // ------------------------------------------------------------------
    // 3. Real network scan against the sim BMC plane.
    //    TODO: requires admin-only scanNetwork / pollNetworkScan endpoints.
    // ------------------------------------------------------------------
    console.log('[commissioning] step: network scan -- real, against the sim BMC zone');
    const scanResult = await scanNetwork(hubAdmin, zoneId!, [BMC_SUBNET]);
    expect(scanResult.status, `scan_network rejected (${scanResult.status}): ${JSON.stringify(scanResult.body)}`).toBe(
      200,
    );
    const planId = scanResult.body.planId as string;

    // Poll the bridge-side raw Redis key (avoids the NetBox-dedup 500).
    const rawResult = await pollUntil(
      () => bridgeRedis.getNetworkScanResult(planId),
      (r) => {
        if (!r) return false;
        const status = r.status as string | undefined;
        return status === 'complete' || status === 'failed';
      },
      { timeout: 180_000, interval: 5_000 },
    );
    expect(rawResult).toBeTruthy();
    expect(rawResult!.status).toBe('complete');

    // The scan ran for real against the zone. The sim's ipmi_sim/sushy are real
    // responders, but routing/timing can vary -- assert completion, warn
    // (don't fail) if it found no hosts.
    const scanResults = ((rawResult!.result as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
    const hosts = (scanResults.scanResults ?? {}) as Record<string, unknown>;
    if (Object.keys(hosts).length === 0) {
      console.log(`[commissioning] scan found no hosts on ${BMC_SUBNET} (result=${JSON.stringify(rawResult)})`);
    }

    // Best-effort merge assertion via the API. In sim this often 500s on
    // the NetBox dedup; only assert the merge when it returns cleanly.
    const pollResult = await pollNetworkScan(hubAdmin, planId);
    if (pollResult.status === 200 && pollResult.body?.status === 'complete') {
      const target = ipmiMac.replace(/[:\-]/g, '').toUpperCase();
      const devices = ((pollResult.body.result as Record<string, unknown> | undefined)?.scanResults ?? {}) as Record<
        string,
        unknown
      >;
      const matched = Object.values(devices).filter((d) => {
        if (typeof d !== 'object' || d === null) return false;
        const rec = d as Record<string, unknown>;
        const mac = ((rec.macAddress as string) ?? '').replace(/[:\-]/g, '').toUpperCase();
        return mac === target;
      });
      if (matched.length > 0) {
        const d = matched[0] as Record<string, unknown>;
        expect(d.enriched, `scanned device not enriched: ${JSON.stringify(d)}`).toBe(true);
        expect(d.serial, `enrichment serial mismatch: ${JSON.stringify(d)}`).toBe(serial);
      }
    } else {
      console.log(`[commissioning] pollNetworkScan unavailable in sim (${pollResult.status}); merge assertion skipped`);
    }

    // ------------------------------------------------------------------
    // 4. Enqueue the commission saga (drives the lifecycle via the hub).
    // ------------------------------------------------------------------
    console.log('[commissioning] step: commission saga -- commissionDiscoveredDevice');
    const commissionResult = await hubAdmin.commissionDiscoveredDevice({
      id: String(id),
      macAddress: ipmiMac,
      ipmiLogin: 'ADMIN',
      ipmiPassword: 'ADMIN',
    });
    expect(
      commissionResult.status,
      `commission rejected (${commissionResult.status}): ${JSON.stringify(commissionResult.body)}`,
    ).toBe(200);

    // Poll until Device.status flips to STAGED
    const stagedStatus = await pollUntil(
      async () => {
        const state = await hubDb.getServerState(deviceId);
        return state.deviceStatus;
      },
      (s) => s === 'STAGED',
      { timeout: 60_000, interval: 3_000 },
    );
    expect(stagedStatus, `commission did not flip Device.status to STAGED (got ${stagedStatus})`).toBe('STAGED');

    // ------------------------------------------------------------------
    // 5. Wait for the qualify auto-orchestration to drive the full lifecycle:
    //    commission (wipe + collect) -> discovery.complete -> qualify provision
    //    (real OS deploy) -> phone-home provisioned -> deprovision (wipe)
    //    -> promote. Two real wipes + a full deploy -- the slowest scenario
    //    in the suite.
    //
    //    TODO(scan-endpoints): with DeviceCommissioningProgress removed there's no
    //    `progress=Done` terminal flag; completion is `lifecycleStatus=INVENTORY`.
    //    The gate below requires an actual lifecycle transition (leave INVENTORY,
    //    then return), so it can no longer race past the cycle the way a plain
    //    `==INVENTORY` predicate did against a device that starts at INVENTORY.
    //    Remaining dependency: the scan flow that seeds/scans a fresh role=null
    //    commissioning device (starting outside INVENTORY) isn't built yet, so the
    //    suite stays skipped -- un-skipping now would run destructively against a
    //    device picked from existing inventory.
    //
    //    Two-phase wait so the starting state can never satisfy the gate:
    //    (1) the device must LEAVE INVENTORY (enter PROVISIONING/PROVISIONED/
    //        DEPROVISIONING), proving commissioning actually started, THEN
    //    (2) it must return to INVENTORY (or FAILED), proving the cycle completed.
    // ------------------------------------------------------------------
    console.log('[commissioning] step: await commissioning to leave INVENTORY (cycle started)');
    const startedState = await pollUntil(
      () => hubDb.getServerState(deviceId),
      (s) =>
        s.lifecycleStatus === 'PROVISIONING' ||
        s.lifecycleStatus === 'PROVISIONED' ||
        s.lifecycleStatus === 'DEPROVISIONING' ||
        s.lifecycleStatus === 'FAILED',
      // Commissioning has to wipe + boot the box before the lifecycle flips off
      // INVENTORY -- give it room, but far short of the full-cycle budget.
      { timeout: 600_000, interval: 15_000 },
    );
    expect(
      startedState.lifecycleStatus,
      `commissioning never left INVENTORY (still ${startedState.lifecycleStatus}) -- cycle did not start`,
    ).not.toBe('INVENTORY');
    expect(
      startedState.lifecycleStatus,
      `commissioning ended in ${startedState.lifecycleStatus} before the cycle ran`,
    ).not.toBe('FAILED');

    console.log('[commissioning] step: await commissioning complete (back to lifecycleStatus=INVENTORY)');
    const finalState = await pollUntil(
      () => hubDb.getServerState(deviceId),
      (s) => s.lifecycleStatus === 'INVENTORY' || s.lifecycleStatus === 'FAILED',
      // Commission wipe + full OS deploy + deprovision wipe -- three sub-phases, each
      // comparable to a single lifecycle. Lifecycle's 900s is per-cycle, so
      // this scenario needs ~2x that.
      { timeout: 1_800_000, interval: 20_000 },
    );
    expect(
      finalState.lifecycleStatus,
      `commissioning ended in ${finalState.lifecycleStatus} (expected INVENTORY)`,
    ).toBe('INVENTORY');

    const record = await bridgeRedis.getDeviceRecord(deviceId);
    if (record !== null) {
      expect(record.status, `device-record atom not INVENTORY: ${JSON.stringify(record)}`).toBe('INVENTORY');
    }

    // Leave the device commissioned (INVENTORY) -- no reset.
  }, 2_400_000); // generous timeout for the slowest scenario
});
