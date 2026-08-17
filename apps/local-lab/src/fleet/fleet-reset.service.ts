import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { z } from 'zod';

import { getErrorMessage } from '../common/errors';
import { hubApiFetch, hubApiSignIn, simDeviceIndex, simDeviceUuid } from '../common/hub-client';
import { sleep } from '../common/sleep';
import { RedisConnectionsService } from '../datastore/redis-connections.service';
import { URLS } from '../ports';
import { QueueReaderService } from '../queues/queue-reader.service';
import {
  HUB_QUEUE_PREFIX,
  QUEUE_LIST_STATES,
  QUEUE_SET_STATES,
  QUEUE_ZSET_STATES,
  queueKey,
  SAGA_QUEUE_NAMES,
} from '../queues/saga-topology';
import type { RunState } from '../runner/runner.service';
import { RunnerService } from '../runner/runner.service';
import { type FleetOpLease, FleetOpRegistry } from './fleet-op-registry';
import { FleetPowerService } from './fleet-power.service';
import { FleetTopologyService } from './fleet-topology.service';

const HubServerStorageSchema = z
  .object({
    storageLayouts: z
      .object({
        configs: z
          .array(
            z.object({ disks: z.array(z.unknown()).optional(), disk_group_name: z.string().nullish() }).passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .nullish(),
  })
  .passthrough();

const CollectInventorySchema = z.object({ jobId: z.union([z.string(), z.number()]).optional() }).passthrough();

@Injectable()
export class FleetResetService {
  private readonly log = new Logger(FleetResetService.name);
  private discoverDeadlineMs = 420_000;

  constructor(
    private readonly runner: RunnerService,
    private readonly queueReader: QueueReaderService,
    private readonly topology: FleetTopologyService,
    private readonly power: FleetPowerService,
    private readonly opRegistry: FleetOpRegistry,
    private readonly connections: RedisConnectionsService,
  ) {}

  discoverNative(nodeIndex: number, lease?: FleetOpLease): string {
    const names = this.topology.nodeNames();
    if (nodeIndex < 0 || nodeIndex >= names.length)
      throw new BadRequestException(`node index ${nodeIndex} out of range (fleet has ${names.length} nodes)`);
    const nodeName = names[nodeIndex];
    const deviceId = simDeviceUuid(nodeIndex);
    const hubBase = URLS.hubBase;

    const run = this.runner.create({ section: 'fleet', opId: 'discover', label: `discover ${nodeName}` });
    lease?.bind(run.runId);
    this.log.log(`fleet discover: ${nodeName}`);

    void (async () => {
      try {
        const jar = await hubApiSignIn(hubBase);

        let payloadWarned = false;
        const warnIfUnparsable = (respCode: number, respBody: unknown): void => {
          if (payloadWarned || respCode !== 200 || HubServerStorageSchema.safeParse(respBody).success) return;
          this.runner.emit(run, `[discover] hub server payload didn't parse — treating storageLayouts as empty\r\n`);
          payloadWarned = true;
        };

        const { code: getCode, body: server } = await hubApiFetch(hubBase, jar, 'GET', `/api/v1/servers/${deviceId}`);
        warnIfUnparsable(getCode, server);
        const before = this.diskSignature(getCode === 200 ? server : null);
        this.runner.emit(
          run,
          `[discover] forcing discovery on ${nodeName} (${deviceId.slice(-4)}) -- storageLayouts has ${before.total} disk(s)\r\n`,
        );
        this.runner.emit(
          run,
          `[discover] the node must be powered on + in brokkr-live so the agent can answer collection\r\n`,
        );

        const { code: discCode, body: discBody } = await hubApiFetch(
          hubBase,
          jar,
          'POST',
          `/api/v1/servers/${deviceId}/collect-inventory`,
          {},
        );
        if (discCode !== 200) {
          this.runner.emit(run, `[discover] force-discovery rejected (${discCode}): ${JSON.stringify(discBody)}\r\n`);
          this.runner.finalize(run, 1);
          return;
        }
        const parsedDisc = CollectInventorySchema.safeParse(discBody);
        const jobId = (parsedDisc.success ? parsedDisc.data.jobId : undefined) ?? 'unknown';
        this.runner.emit(run, `[discover] inventory_collection enqueued (job ${jobId}) -- collecting hardware...\r\n`);

        const deadline = Date.now() + this.discoverDeadlineMs;
        while (Date.now() < deadline) {
          await sleep(10_000);
          const { code: pollCode, body: pollServer } = await hubApiFetch(
            hubBase,
            jar,
            'GET',
            `/api/v1/servers/${deviceId}`,
          );
          warnIfUnparsable(pollCode, pollServer);
          const now = this.diskSignature(pollCode === 200 ? pollServer : null);
          this.runner.emit(run, `[discover] storageLayouts: ${now.total} disk(s) in [${now.groups.join(', ')}]\r\n`);
          if (now.total !== before.total || now.groups.join(',') !== before.groups.join(',')) {
            this.runner.emit(
              run,
              `[discover] discovery landed -- storageLayouts now has ${now.total} disk(s); open the disk-layout picker\r\n`,
            );
            this.runner.finalize(run, 0);
            return;
          }
        }
        this.runner.emit(
          run,
          `[discover] FAILED: no storageLayouts change within ${Math.round(this.discoverDeadlineMs / 1000)}s.\r\n`,
        );
        this.runner.emit(
          run,
          `[discover] If this node's disks already match the seeded layout, re-discovery is a no-op — otherwise check the spoke logs (the node must be powered on in brokkr-live).\r\n`,
        );
        this.runner.finalize(run, 1);
      } catch (e) {
        const msg = e instanceof TypeError ? `Hub API not reachable at ${hubBase}` : getErrorMessage(e);
        this.runner.emit(run, `[discover] error: ${msg}\r\n`);
        this.runner.finalize(run, 1);
      } finally {
        lease?.release();
      }
    })();
    return run.runId;
  }

  private diskSignature(body: unknown): { total: number; groups: string[] } {
    const parsed = HubServerStorageSchema.safeParse(body);
    const configs = parsed.success ? (parsed.data.storageLayouts?.configs ?? []) : [];
    const total = configs.reduce((sum, c) => sum + (c.disks?.length ?? 0), 0);
    const groups = configs.map((c) => c.disk_group_name ?? '').sort();
    return { total, groups };
  }

  discover(name: string): string {
    const names = this.topology.nodeNames();
    if (!names.includes(name)) throw new NotFoundException(`unknown node '${name}'`);
    // acquire before runner.create so a 409 never leaves an orphan run behind.
    const lease = this.opRegistry.acquire({ kind: 'node', name }, `discover ${name}`);
    try {
      return this.discoverNative(names.indexOf(name), lease);
    } catch (e) {
      lease.release();
      throw e;
    }
  }

  /** Ordering: discover affected devices → power-cycle them (clears stale brokkr-live) → reset Postgres → reset Redis → commit Postgres only after Redis succeeds. */
  reset(name: string): string {
    const names = this.topology.nodeNames();
    if (!names.includes(name)) throw new NotFoundException(`unknown node '${name}'`);
    const nodeIndex = names.indexOf(name);
    // acquire before runner.create so a 409 never leaves an orphan run behind.
    const lease = this.opRegistry.acquire({ kind: 'fleet' }, `reset ${name}`);
    let run: RunState;
    try {
      run = this.runner.create({ section: 'fleet', opId: 'reset', label: `reset ${name}` });
      lease.bind(run.runId);
    } catch (e) {
      lease.release();
      throw e;
    }
    this.log.log(`fleet reset: ${name}`);
    void this.resetDeviceNative(nodeIndex, run)
      .then(() => this.runner.finalize(run, 0))
      .catch((err) => {
        this.runner.emit(run, `\r\n[error] ${getErrorMessage(err)}\r\n`);
        this.runner.finalize(run, 1);
      })
      .finally(() => lease.release());
    return run.runId;
  }

  async resetDeviceNative(
    nodeIndex: number,
    run: RunState,
  ): Promise<{
    deployments_closed: number;
    reservations_closed: number;
    lifecycle_reset: number;
    jobs_deleted: number;
    device_status_reset: number;
    atom_keys_deleted: number;
    bull_effects_deleted: number;
    saga_jobs_deleted: number;
  }> {
    const names = this.topology.nodeNames();
    if (nodeIndex < 0 || nodeIndex >= names.length) {
      throw new Error(`node index ${nodeIndex} out of range (fleet has ${names.length} nodes)`);
    }
    const nodeName = names[nodeIndex];
    const deviceId = simDeviceUuid(nodeIndex);

    this.runner.emit(run, `\r\n[reset] ${nodeName} (${deviceId.slice(-4)}) -> clean INVENTORY\r\n`);

    const pgUrl = process.env.HUB_DATABASE_URL ?? URLS.pg;
    const redisUrl = this.connections.url('bridge');

    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: pgUrl, max: 2 });
    try {
      const affected = await this.discoverAffectedDevices(pool, deviceId);
      if (affected.length === 0) {
        throw new Error(`device ${deviceId} has no Server row (run sim:seed first)`);
      }

      const cycleNames: string[] = [];
      for (const { deviceId: dId } of affected) {
        const idx = simDeviceIndex(dId);
        if (idx === null) {
          this.log.warn(`skipping non-sim device id ${dId} — not a deterministic fleet uuid, cannot map to a node`);
          continue;
        }
        if (idx < names.length && !cycleNames.includes(names[idx])) {
          cycleNames.push(names[idx]);
        }
      }

      if (affected.length > 1) {
        this.runner.emit(run, `[reset] co-reserved siblings will also reset: ${affected.length - 1} device(s)\r\n`);
      }
      if (cycleNames.length === 0) {
        throw new Error(
          `no fleet nodes resolved for affected devices [${affected.map((a) => a.deviceId).join(', ')}] -- hub seed is out of sync with the current fleet.yml? (re-run sim:seed)`,
        );
      }

      for (const name of cycleNames) {
        this.runner.emit(run, `[reset] power-cycle ${name} (clears stale brokkr-live session)\r\n`);
        const rc = await this.power.powerCycleRedfish(name);
        if (rc !== 0) {
          throw new Error(`power-cycle for ${name} failed (exit ${rc}) -- reset aborted (hub/redis untouched)`);
        }
      }

      const affectedDeviceIds = affected.map((a) => a.deviceId);
      const affectedForRedis = affected.map((a) => ({ deviceId: a.deviceId, zoneId: a.zoneId }));

      const client = await pool.connect();
      let pgCounts: Record<string, number>;
      let redisCounts: Record<string, number>;
      try {
        await client.query('BEGIN');

        pgCounts = await this.resetPostgres(client, deviceId, affectedDeviceIds);
        for (const [k, v] of Object.entries(pgCounts)) {
          this.runner.emit(run, `[reset] postgres: ${k}=${v}\r\n`);
        }

        redisCounts = await this.resetRedis(redisUrl, affectedForRedis);
        for (const [k, v] of Object.entries(redisCounts)) {
          this.runner.emit(run, `[reset] redis: ${k}=${v}\r\n`);
        }

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }

      this.runner.emit(run, `[reset] reset complete for ${nodeName}\r\n`);
      return {
        deployments_closed: pgCounts.deployments_closed ?? 0,
        reservations_closed: pgCounts.reservations_closed ?? 0,
        lifecycle_reset: pgCounts.lifecycle_reset ?? 0,
        jobs_deleted: pgCounts.jobs_deleted ?? 0,
        device_status_reset: pgCounts.device_status_reset ?? 0,
        atom_keys_deleted: redisCounts.atom_keys_deleted ?? 0,
        bull_effects_deleted: redisCounts.bull_effects_deleted ?? 0,
        saga_jobs_deleted: redisCounts.saga_jobs_deleted ?? 0,
      };
    } finally {
      await pool.end();
    }
  }

  private async discoverAffectedDevices(
    pool: import('pg').Pool,
    deviceId: string,
  ): Promise<{ deviceId: string; name: string; zoneId: string }[]> {
    const client = await pool.connect();
    try {
      const serverRow = await client.query('SELECT id FROM "Server" WHERE "deviceId" = $1', [deviceId]);
      if (serverRow.rows.length === 0) return [];
      const serverId: string = serverRow.rows[0].id;

      const openSiblingServers = `
        SELECT sir2."serverId" FROM "ServersInReservation" sir2
        JOIN "Reservation" r2 ON r2.id = sir2."reservationId"
        WHERE r2."endDate" IS NULL
          AND sir2."reservationId" IN (
            SELECT sir."reservationId" FROM "ServersInReservation" sir
            JOIN "Reservation" r ON r.id = sir."reservationId"
            WHERE sir."serverId" = $2 AND r."endDate" IS NULL
          )`;

      const result = await client.query(
        `SELECT d.id, d.name, d."zoneId" FROM "Device" d
         JOIN "Server" s ON s."deviceId" = d.id
         WHERE s.id = $1 OR s.id IN (${openSiblingServers})`,
        [serverId, serverId],
      );
      return result.rows.map((r: Record<string, unknown>) => ({
        deviceId: String(r.id),
        name: String(r.name),
        zoneId: String(r.zoneId),
      }));
    } finally {
      client.release();
    }
  }

  private async resetPostgres(
    client: import('pg').PoolClient,
    targetDeviceId: string,
    affectedDeviceIds: string[],
  ): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};

    const serverRow = await client.query('SELECT id FROM "Server" WHERE "deviceId" = $1', [targetDeviceId]);
    if (serverRow.rows.length === 0) {
      throw new Error(`device ${targetDeviceId} has no Server row (run sim:seed first)`);
    }
    const serverId: string = serverRow.rows[0].id;

    const openSiblingServers = `
      SELECT sir2."serverId" FROM "ServersInReservation" sir2
      JOIN "Reservation" r2 ON r2.id = sir2."reservationId"
      WHERE r2."endDate" IS NULL
        AND sir2."reservationId" IN (
          SELECT sir."reservationId" FROM "ServersInReservation" sir
          JOIN "Reservation" r ON r.id = sir."reservationId"
          WHERE sir."serverId" = $2 AND r."endDate" IS NULL
        )`;

    const deployRes = await client.query(
      `UPDATE "Deployment" SET "endDate" = NOW(), "updatedAt" = NOW()
       WHERE "endDate" IS NULL AND ("serverId" = $1 OR "serverId" IN (${openSiblingServers}))`,
      [serverId, serverId],
    );
    counts.deployments_closed = deployRes.rowCount ?? 0;

    const resrvRes = await client.query(
      `UPDATE "Reservation" SET "endDate" = NOW(), "updatedAt" = NOW()
       WHERE "endDate" IS NULL
       AND id IN (SELECT "reservationId" FROM "ServersInReservation" WHERE "serverId" = $1)`,
      [serverId],
    );
    counts.reservations_closed = resrvRes.rowCount ?? 0;

    const lcRes = await client.query(
      `UPDATE "Server" SET "lifecycleStatus" = 'INVENTORY', "updatedAt" = NOW()
       WHERE "lifecycleStatus" != 'INVENTORY'
       AND (id = $1 OR id IN (${openSiblingServers}))`,
      [serverId, serverId],
    );
    counts.lifecycle_reset = lcRes.rowCount ?? 0;

    const jobRes = await client.query('DELETE FROM "Job" WHERE "deviceId" = ANY($1)', [affectedDeviceIds]);
    counts.jobs_deleted = jobRes.rowCount ?? 0;

    const devRes = await client.query(
      `UPDATE "Device" SET status = 'ACTIVE', "updatedAt" = NOW()
       WHERE id = ANY($1) AND status != 'ACTIVE'`,
      [affectedDeviceIds],
    );
    counts.device_status_reset = devRes.rowCount ?? 0;

    return counts;
  }

  private async resetRedis(
    url: string,
    devices: { deviceId: string; zoneId: string }[],
  ): Promise<Record<string, number>> {
    const Redis = (await import('ioredis')).default;
    const r = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: 2, connectTimeout: 5_000 });
    r.on('error', () => {});

    try {
      const allAtomKeys: string[] = [];
      const allBullKeys: string[] = [];
      const sagaJobsByQueue = new Map<string, string[]>();

      for (const { deviceId: dId, zoneId } of devices) {
        allAtomKeys.push(
          `${zoneId}:device:${dId}:device_record`,
          `${zoneId}:device:${dId}:pointers`,
          `${zoneId}:device:${dId}:config:netplan:live`,
        );

        let cursor = '0';
        do {
          const [next, keys] = await r.scan(cursor, 'MATCH', `${zoneId}:device:${dId}:lifecycle:*`, 'COUNT', 200);
          cursor = next;
          for (const k of keys) allAtomKeys.push(k);
        } while (cursor !== '0');

        cursor = '0';
        do {
          const [next, keys] = await r.scan(
            cursor,
            'MATCH',
            queueKey(HUB_QUEUE_PREFIX, 'device-status-effects', `device-${dId}-*`),
            'COUNT',
            200,
          );
          cursor = next;
          for (const k of keys) allBullKeys.push(k);
        } while (cursor !== '0');

        for (const queue of SAGA_QUEUE_NAMES) {
          const prefix = `${zoneId}:${queue}:`;
          cursor = '0';
          do {
            const [next, keys] = await r.scan(cursor, 'MATCH', `${prefix}${dId}-*`, 'COUNT', 200);
            cursor = next;
            for (const k of keys) {
              const mapKey = `${zoneId}:${queue}`;
              const jobId = k.slice(prefix.length);
              const existing = sagaJobsByQueue.get(mapKey) ?? [];
              existing.push(jobId);
              sagaJobsByQueue.set(mapKey, existing);
            }
          } while (cursor !== '0');
        }
      }

      const counts: Record<string, number> = { atom_keys_deleted: 0, bull_effects_deleted: 0, saga_jobs_deleted: 0 };

      if (allAtomKeys.length === 0 && allBullKeys.length === 0 && sagaJobsByQueue.size === 0) {
        return counts;
      }

      const pipe = r.multi();
      if (allAtomKeys.length > 0) {
        pipe.del(...allAtomKeys);
      }
      if (allBullKeys.length > 0) {
        pipe.del(...allBullKeys);
      }

      for (const [mapKey, jobIds] of sagaJobsByQueue.entries()) {
        const parts = mapKey.split(':');
        const zoneId = parts.slice(0, -1).join(':');
        const queue = parts[parts.length - 1];
        const prefix = `${zoneId}:${queue}:`;
        pipe.del(...jobIds.map((jid) => `${prefix}${jid}`));
        for (const jid of jobIds) {
          for (const idx of QUEUE_LIST_STATES) {
            pipe.lrem(`${prefix}${idx}`, 0, jid);
          }
          for (const idx of QUEUE_ZSET_STATES) {
            pipe.zrem(`${prefix}${idx}`, jid);
          }
          for (const idx of QUEUE_SET_STATES) {
            pipe.srem(`${prefix}${idx}`, jid);
          }
        }
      }

      const results = await pipe.exec();
      if (!results) return counts;

      let i = 0;
      if (allAtomKeys.length > 0) {
        counts.atom_keys_deleted = Number(results[i]?.[1] ?? 0);
        i++;
      }
      if (allBullKeys.length > 0) {
        counts.bull_effects_deleted = Number(results[i]?.[1] ?? 0);
        i++;
      }

      const perJobOps = QUEUE_LIST_STATES.length + QUEUE_ZSET_STATES.length + QUEUE_SET_STATES.length;
      for (const jobIds of sagaJobsByQueue.values()) {
        counts.saga_jobs_deleted += Number(results[i]?.[1] ?? 0);
        i += 1 + jobIds.length * perJobOps;
      }

      return counts;
    } finally {
      r.disconnect();
    }
  }

  async countActiveSagaJobs(): Promise<number> {
    return this.queueReader.inFlightCount();
  }
}
