import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BridgeRedis, type SolLogEntry } from './bridge-redis';
import { dataIpForDevice, loadFleet, pollUntil, type Fleet } from './helpers';
import { HubAdminClient } from './hub-client';
import { HubDB } from './hub-db';
import { awaitProvisioned, endRentalToInventory, selectInventoryDevice } from './lifecycle-helpers';

const SOL_END_TIMEOUT_MS = 315_000;
const CONSOLE_LINE = /login:|\[\s*\d+\.\d+\]/;

function endsWithEndMarker(entries: SolLogEntry[]): boolean {
  return entries.at(-1)?.message === 'END LOG COLLECTION';
}

describe('sol capture', { timeout: 3_600_000 }, () => {
  let hubAdmin: HubAdminClient;
  let hubDb: HubDB;
  let bridgeRedis: BridgeRedis;
  let fleet: Fleet;

  beforeAll(async () => {
    fleet = loadFleet();
    hubAdmin = new HubAdminClient();
    await hubAdmin.signIn();
    hubDb = HubDB.fromEnv();
    bridgeRedis = BridgeRedis.fromEnv();
  });

  afterAll(async () => {
    await hubDb.prisma.$disconnect();
    await bridgeRedis.disconnect();
  });

  it('captures the serial console of a sim deprovision', { timeout: 3_600_000 }, async ({ skip }) => {
    const deviceId = await selectInventoryDevice(hubDb, fleet);
    if (!deviceId) {
      skip('SKIP: no INVENTORY device available; reset one with end-rental first');
      return;
    }
    const ip = dataIpForDevice(fleet, deviceId);
    const awaitSolEnded = (jobId: string) =>
      pollUntil(() => bridgeRedis.getSolLog(deviceId, jobId), endsWithEndMarker, {
        timeout: SOL_END_TIMEOUT_MS,
        interval: 5_000,
      });

    const provisionJobId = await awaitProvisioned(hubAdmin, hubDb, bridgeRedis, ip, deviceId, {
      kind: 'provision',
      deploymentName: 'e2e-sol-capture',
    });
    await awaitSolEnded(provisionJobId);

    const deprovisionJobId = await endRentalToInventory(hubAdmin, hubDb, deviceId);
    expect(deprovisionJobId, 'end-rental returned no deprovision job id').toBeTruthy();

    const messages = (await awaitSolEnded(deprovisionJobId!)).map((entry) => entry.message);
    console.log(`sol capture [${messages.length}] job=${deprovisionJobId}\n${messages.join('\n')}`);

    expect(messages[0]).toBe('BEGIN LOG COLLECTION');
    expect(messages.at(-1)).toBe('END LOG COLLECTION');
    expect(messages.slice(1, -1).some((message) => CONSOLE_LINE.test(message))).toBe(true);
  });
});
