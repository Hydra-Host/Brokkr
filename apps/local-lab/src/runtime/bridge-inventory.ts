import type { ZoneBridge } from '../contract';
import type { PresenceRecord } from './leader.reader';
import { epochMsFromFloatSeconds, isLeaderFlag, isPresenceFresh, parseInterfaces, parsePlugins } from './runtime-keys';

export interface ConfiguredBridge {
  instanceId: string;
  port: number;
  grpcPort: number;
}

function fromPresence(record: PresenceRecord, configured: ConfiguredBridge | undefined, nowMs: number): ZoneBridge {
  const registeredAtMs = epochMsFromFloatSeconds(record.hash.registered_at);
  return {
    instanceId: record.instanceId,
    expected: configured !== undefined,
    registered: true,
    isLeader: isLeaderFlag(record.hash.is_leader),
    online: isPresenceFresh(registeredAtMs, nowMs),
    registeredAtMs,
    workerVersion: record.hash.brokkr_worker_version ?? null,
    liveVersion: record.hash.brokkr_live_version ?? null,
    interfaces: parseInterfaces(record.hash.interfaces_json),
    plugins: parsePlugins(record.hash.active_plugins_json),
    port: configured?.port ?? null,
    grpcPort: configured?.grpcPort ?? null,
    readError: null,
  };
}

function fromConfigOnly(configured: ConfiguredBridge): ZoneBridge {
  return {
    instanceId: configured.instanceId,
    expected: true,
    registered: false,
    isLeader: null,
    online: null,
    registeredAtMs: null,
    workerVersion: null,
    liveVersion: null,
    interfaces: null,
    plugins: null,
    port: configured.port,
    grpcPort: configured.grpcPort,
    readError: null,
  };
}

/** Union, not intersection: a configured bridge that never registered is the HA symptom worth seeing,
 *  and one that registered without being configured is an orphan that must stay visible. */
export function buildBridgeInventory(
  presence: PresenceRecord[],
  configured: ConfiguredBridge[],
  nowMs: number,
): ZoneBridge[] {
  const byInstance = new Map(configured.map((bridge) => [bridge.instanceId, bridge]));
  const rows = presence.map((record) => fromPresence(record, byInstance.get(record.instanceId), nowMs));
  const seen = new Set(rows.map((row) => row.instanceId));
  for (const bridge of configured) {
    if (!seen.has(bridge.instanceId)) rows.push(fromConfigOnly(bridge));
  }
  return rows.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
}
