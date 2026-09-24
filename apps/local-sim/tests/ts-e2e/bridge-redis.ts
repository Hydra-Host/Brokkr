/**
 * Bridge Redis client for TS e2e tests.
 *
 * Port of the Python BridgeRedis class from scripts/local/stores.py.
 * Reads device record atoms and other bridge-side Redis keys using
 * zone-prefixed key conventions that match the spoke's Redis layout.
 */

import Redis from 'ioredis';
import { z } from 'zod';

import type { HubDB } from './hub-db';

const SolLogEntrySchema = z.object({
  timestamp: z.string(),
  message: z.string(),
});

export type SolLogEntry = z.infer<typeof SolLogEntrySchema>;

export interface WriteDiscoveryPendingOpts {
  ipmiMac: string;
  dataMac: string;
  dataIp: string;
  serial: string;
  manufacturer?: string;
  ttl?: number;
  deviceId?: string;
}

export class BridgeRedis {
  private readonly zoneCache = new Map<string, string>();

  constructor(
    private readonly client: Redis,
    private readonly zoneId: string,
    private readonly hubDb?: HubDB,
  ) {}

  static fromEnv(hubDb?: HubDB): BridgeRedis {
    const url = process.env.BRIDGE_REDIS_URL ?? 'redis://127.0.0.1:6379';
    const zoneId = process.env.BRIDGE_ZONE_ID;
    if (!zoneId) {
      throw new Error('BRIDGE_ZONE_ID environment variable is required');
    }
    return new BridgeRedis(new Redis(url), zoneId, hubDb);
  }

  private async zoneFor(deviceId: string): Promise<string> {
    const cached = this.zoneCache.get(deviceId);
    if (cached) return cached;
    if (this.hubDb) {
      const info = await this.hubDb.getDeviceIdentityAndZone(deviceId);
      if (info.zoneId) {
        this.zoneCache.set(deviceId, info.zoneId);
        return info.zoneId;
      }
    }
    return this.zoneId;
  }

  /**
   * Read the device-record atom at {zone}:device:{id}:device_record,
   * returning its inner `value` payload (status / last_job_id track the
   * lifecycle in lockstep with Hub). null if the bridge hasn't rendered
   * it yet.
   */
  async getDeviceRecord(deviceId: string): Promise<Record<string, unknown> | null> {
    const zone = await this.zoneFor(deviceId);
    const key = `${zone}:device:${deviceId}:device_record`;
    const raw = await this.client.get(key);
    if (!raw) return null;
    const doc = JSON.parse(raw) as Record<string, unknown>;
    return (doc.value as Record<string, unknown>) ?? doc;
  }

  async getIpxeUrl(deviceId: string): Promise<string | null> {
    const zone = await this.zoneFor(deviceId);
    const key = `${zone}:device:${deviceId}:config:ipxe_url`;
    return await this.client.get(key);
  }

  /**
   * FAKE the iPXE -> IPMI -> Redis enrichment seam: write a
   * {zone}:discovery:pending:{mac} hash the hub's
   * enrichWithPendingDeviceData merges into scanned devices.
   *
   * In sim, enrichment can never arrive from real iPXE, so the test
   * injects it directly. The hub SCANs {zone}:discovery:pending:* and
   * joins by MAC (mac and ipmi_mac, normalized uppercase, separators
   * stripped). Returns the Redis key.
   */
  async writeDiscoveryPending(opts: WriteDiscoveryPendingOpts): Promise<string> {
    const { ipmiMac, dataMac, dataIp, serial, manufacturer = 'QEMU', ttl = 3600, deviceId } = opts;

    let zone = this.zoneId;
    if (deviceId) {
      zone = await this.zoneFor(deviceId);
    }
    const normalizedMac = ipmiMac.replace(/[:\-]/g, '');
    const key = `${zone}:discovery:pending:${normalizedMac}`;

    await this.client.hset(key, {
      mac: dataMac,
      ipmi_mac: ipmiMac,
      ip: dataIp,
      serial,
      board_serial: `BOARD-${serial}`,
      chassis_serial: `CHASSIS-${serial}`,
      manufacturer,
    });

    if (ttl > 0) {
      await this.client.expire(key, ttl);
    }

    return key;
  }

  /**
   * Read the bridge-side raw scan result at network-scan:result:{planId}
   * (plain key, NOT zone-prefixed -- network-scan.service.ts:resultKey).
   *
   * Polling this avoids the NetBox-dedup 500 in the hub's pollNetworkScan:
   * {status: pending|complete|failed, result?, error?}. null if unset.
   */
  async getNetworkScanResult(planId: string): Promise<Record<string, unknown> | null> {
    const key = `network-scan:result:${planId}`;
    const raw = await this.client.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as Record<string, unknown>;
  }

  /**
   * Read the SOL console capture at {zone}:sol:logs:{planId}, one entry per
   * console line between the BEGIN/END LOG COLLECTION markers. Empty until the
   * bridge's first flush.
   */
  async getSolLog(deviceId: string, planId: string): Promise<SolLogEntry[]> {
    const zone = await this.zoneFor(deviceId);
    const raw = await this.client.lrange(`${zone}:sol:logs:${planId}`, 0, -1);
    return raw.map((entry) => SolLogEntrySchema.parse(JSON.parse(entry)));
  }

  /**
   * Disconnect the underlying Redis client. Call this in test teardown.
   */
  async disconnect(): Promise<void> {
    await this.client.quit();
  }
}
