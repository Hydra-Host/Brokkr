import { Injectable } from '@nestjs/common';

import { isRecord } from '@repo/utils';

import { getErrorMessage } from '../common/error-utils';
import { deviceDiscoveryCollector, deviceDiscoveryPattern } from '../common/redis/redis-keys';
import type { ZoneCryptoSnapshot } from '../zone-crypto/zone-crypto.service';

import { getBullmqConfig } from './bullmq.config';
import { MAX_COLLECTOR_PAYLOAD_BYTES, RESULT_JOB_NAME } from './bullmq.types';
import { oversizedCollectorFields, splitCollectorForCache } from './collector-cache-split';
import {
  buildDiscoveryCompletePayload,
  buildJobCompletedPayload,
  buildPhoneHomePayload,
  buildResultPayload,
} from './results.payloads';
import { sealOutboundPayload, type SealedEnvelope, type ZoneCryptoState } from './seal-outbound-payload';

export type OutboundPayload = Record<string, unknown> | SealedEnvelope;

export interface ResultsQueueAddOptions {
  removeOnComplete: { count: number };
  removeOnFail: { count: number };
}

export interface ResultsQueue {
  name: string;
  add(name: string, data: OutboundPayload, opts: ResultsQueueAddOptions): Promise<unknown>;
}

export interface ResultsQueueProvider {
  getResultsQueue(): Promise<ResultsQueue | null>;
  resetSharedOpsStateOnConnectionError(exc: unknown): Promise<boolean>;
}

export interface ResultsRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<unknown>;
  delete(keys: string[]): Promise<unknown>;
  scan(pattern: string): Promise<string[]>;
}

export interface ResultsRedisProvider {
  getResultsRedis(): Promise<ResultsRedisClient | null>;
  resetSharedOpsStateOnConnectionError(exc: unknown): Promise<boolean>;
}

export interface ZoneCryptoProvider {
  get(): ZoneCryptoSnapshot | null;
}

export interface ZoneIdProvider {
  getZoneId(): string;
}

export interface ResultsLogger {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

const REMOVE_OPTS: ResultsQueueAddOptions = {
  removeOnComplete: { count: 5000 },
  removeOnFail: { count: 1000 },
};

function nowSeconds(): number {
  return Date.now() / 1000;
}

@Injectable()
export class ResultsService {
  // Per-step lifetime: orphans from a crashed step get wiped by the next step's clearCollectionData.
  private readonly inflightFields = new Map<string, Set<string>>();

  constructor(
    private readonly queueProvider: ResultsQueueProvider,
    private readonly redisProvider: ResultsRedisProvider,
    private readonly zoneCrypto: ZoneCryptoProvider,
    private readonly zoneIdProvider: ZoneIdProvider,
    private readonly logger: ResultsLogger,
  ) {}

  private getZonePrefix(): string {
    return getBullmqConfig().redisPrefix;
  }

  private seal(payload: Record<string, unknown>, queueName: string, aadJobId: string): OutboundPayload {
    const snapshot = this.zoneCrypto.get();
    if (snapshot === null) return payload;

    const zoneCrypto: ZoneCryptoState = {
      zonePriv: snapshot.zonePriv,
      hubPub: snapshot.hubPub,
      zoneId: this.zoneIdProvider.getZoneId(),
    };
    return sealOutboundPayload(payload, {
      queueName,
      aadJobId,
      zoneCrypto,
    });
  }

  // Returns [ok, keptCount]; callers treat [true, 0] as a silent-data-loss signal.
  async writeCollectorToResultsCache(args: {
    deviceId: string;
    collector: string;
    data: unknown;
    ttl?: number;
    maxPayloadBytes?: number;
  }): Promise<[boolean, number]> {
    const ttl = args.ttl ?? 600;
    const cap = args.maxPayloadBytes ?? MAX_COLLECTOR_PAYLOAD_BYTES;
    const client = await this.redisProvider.getResultsRedis();
    if (client === null) return [false, 0];

    try {
      for (const { field, rawSize } of oversizedCollectorFields(args.collector, args.data, cap)) {
        await this.logger.warning(
          `Dropping oversized field '${field}' from collector '${args.collector}' ` +
            `for device ${args.deviceId}: ${rawSize} bytes exceeds ${cap} byte cap`,
        );
      }
      const rows = splitCollectorForCache(args.collector, args.data, cap);
      const tracker = this.fieldsFor(args.deviceId);
      for (const { field, payload } of rows) {
        await client.set(deviceDiscoveryCollector(args.deviceId, field), payload, ttl);
        tracker.add(field);
      }
      return [true, rows.length];
    } catch (exc) {
      await this.redisProvider.resetSharedOpsStateOnConnectionError(exc);
      await this.logger.warning(
        `Failed to write collector '${args.collector}' for device ${args.deviceId}: ${getErrorMessage(exc)}`,
      );
      return [false, 0];
    }
  }

  async clearCollectionData(deviceId: string): Promise<boolean> {
    const client = await this.redisProvider.getResultsRedis();
    if (client === null) return false;
    try {
      const tracked = this.inflightFields.get(deviceId);
      const keys =
        tracked && tracked.size > 0
          ? [...tracked].map((f) => deviceDiscoveryCollector(deviceId, f))
          : await client.scan(deviceDiscoveryPattern(deviceId));
      if (keys.length > 0) {
        await client.delete(keys);
      }
      this.inflightFields.delete(deviceId);
      return true;
    } catch (exc) {
      await this.redisProvider.resetSharedOpsStateOnConnectionError(exc);
      await this.logger.warning(`Failed to clear collection cache for device ${deviceId}: ${getErrorMessage(exc)}`);
      return false;
    }
  }

  getCollectionFieldCount(deviceId: string): number | null {
    const tracked = this.inflightFields.get(deviceId);
    return tracked ? tracked.size : null;
  }

  private fieldsFor(deviceId: string): Set<string> {
    let tracked = this.inflightFields.get(deviceId);
    if (!tracked) {
      tracked = new Set();
      this.inflightFields.set(deviceId, tracked);
    }
    return tracked;
  }

  async enqueueDiscoveryComplete(args: { deviceId: string; jobId?: string | null }): Promise<boolean> {
    const jobId = args.jobId ?? 'discovery';
    const logJobId = jobId;
    const queue = await this.queueProvider.getResultsQueue();
    if (queue === null) {
      await this.logger.warning(
        `Results queue unavailable, cannot send discovery.complete for device ${args.deviceId}`,
        { jobId: logJobId },
      );
      return false;
    }

    const fields = [...(this.inflightFields.get(args.deviceId) ?? [])];

    try {
      const payload = buildDiscoveryCompletePayload({
        device_id: args.deviceId,
        fields,
        zone_prefix: this.getZonePrefix(),
        job_id: jobId,
        timestamp: nowSeconds(),
      });
      await queue.add(RESULT_JOB_NAME.DISCOVERY_COMPLETE, this.seal({ ...payload }, queue.name, jobId), REMOVE_OPTS);
      this.inflightFields.delete(args.deviceId);
      await this.logger.info(
        `Discovery complete notification sent for device ${args.deviceId} (${fields.length} fields)`,
        { jobId: logJobId },
      );
      return true;
    } catch (exc) {
      await this.queueProvider.resetSharedOpsStateOnConnectionError(exc);
      await this.logger.warning(
        `Failed to enqueue discovery.complete for device ${args.deviceId}: ${getErrorMessage(exc)}`,
        { jobId: logJobId },
      );
      return false;
    }
  }

  async mergeResolvedIntoSerialPorts(deviceId: string, resolved: Record<string, unknown>): Promise<boolean> {
    const client = await this.redisProvider.getResultsRedis();
    if (client === null) return false;

    const key = deviceDiscoveryCollector(deviceId, 'serial_ports');
    try {
      const raw = await client.get(key);
      if (raw === null) return false;

      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return false;

      const merged: Record<string, unknown> = { ...resolved };
      if (typeof merged['baud'] !== 'number') {
        merged['baud'] = this.carryOverBaud(parsed);
      }

      parsed['resolved'] = merged;
      await client.set(key, JSON.stringify(parsed), 600);
      return true;
    } catch (error) {
      await this.logger.warning(
        `Failed to merge probed serial_ports for device ${deviceId}: ${getErrorMessage(error)}`,
      );
      return false;
    }
  }

  private carryOverBaud(serialPorts: Record<string, unknown>): number {
    const prior = serialPorts['resolved'];
    if (isRecord(prior) && typeof prior['baud'] === 'number') return prior['baud'];
    const hardware = serialPorts['bmc_sol_hardware'];
    if (isRecord(hardware) && typeof hardware['hardware_baud_rate'] === 'number') {
      return hardware['hardware_baud_rate'];
    }
    return 115200;
  }

  async enqueuePhoneHome(args: { deviceId: string; bootId: string }): Promise<boolean> {
    const queue = await this.queueProvider.getResultsQueue();
    if (queue === null) {
      await this.logger.warning(`Results queue unavailable, cannot send device.phone_home for device ${args.deviceId}`);
      return false;
    }

    try {
      const payload = buildPhoneHomePayload({
        device_id: args.deviceId,
        zone_prefix: this.getZonePrefix(),
        boot_id: args.bootId,
        timestamp: nowSeconds(),
      });
      await queue.add(
        RESULT_JOB_NAME.DEVICE_PHONE_HOME,
        this.seal({ ...payload }, queue.name, args.deviceId),
        REMOVE_OPTS,
      );
      await this.logger.info(
        `Brokkr Live phone-home forwarded to hub for device ${args.deviceId} (boot_id=${args.bootId})`,
      );
      return true;
    } catch (exc) {
      await this.queueProvider.resetSharedOpsStateOnConnectionError(exc);
      await this.logger.warning(
        `Failed to enqueue device.phone_home for device ${args.deviceId}: ${getErrorMessage(exc)}`,
      );
      return false;
    }
  }

  async enqueueSecretRevealed(args: {
    requestId: string;
    deviceId: string;
    secret: Record<string, string>;
  }): Promise<boolean> {
    const queue = await this.queueProvider.getResultsQueue();
    if (queue === null) {
      await this.logger.warning(`Results queue unavailable, cannot send secret.revealed for request ${args.requestId}`);
      return false;
    }
    try {
      const payload = {
        request_id: args.requestId,
        device_id: args.deviceId,
        zone_prefix: this.getZonePrefix(),
        secret: args.secret,
        timestamp: nowSeconds(),
      };
      await queue.add(
        RESULT_JOB_NAME.SECRET_REVEALED,
        this.seal({ ...payload }, queue.name, args.requestId),
        REMOVE_OPTS,
      );
      await this.logger.info(`Secret reveal returned to hub for request ${args.requestId} (device ${args.deviceId})`);
      return true;
    } catch (exc) {
      await this.queueProvider.resetSharedOpsStateOnConnectionError(exc);
      await this.logger.warning(
        `Failed to enqueue secret.revealed for request ${args.requestId}: ${getErrorMessage(exc)}`,
      );
      return false;
    }
  }

  async enqueueResult(args: {
    planId: string;
    stepName: string;
    status: string;
    deviceId: unknown;
    eventType?: string;
    actionType?: string;
    result?: Record<string, unknown> | null;
    error?: string | null;
    attempt?: number;
    metadata?: Record<string, unknown> | null;
  }): Promise<boolean> {
    const queue = await this.queueProvider.getResultsQueue();
    if (queue === null) {
      await this.logger.warning(`Results queue unavailable, cannot send result for plan ${args.planId}`, {
        jobId: args.planId,
      });
      return false;
    }

    try {
      const payload = buildResultPayload({
        plan_id: args.planId,
        step_name: args.stepName,
        status: args.status,
        device_id: args.deviceId,
        zone_prefix: this.getZonePrefix(),
        event_type: args.eventType,
        action_type: args.actionType,
        result: args.result,
        error: args.error,
        attempt: args.attempt,
        metadata: args.metadata,
        timestamp: nowSeconds(),
      });
      await queue.add(RESULT_JOB_NAME.JOB_RESULT, this.seal({ ...payload }, queue.name, args.planId), REMOVE_OPTS);
      return true;
    } catch (exc) {
      await this.queueProvider.resetSharedOpsStateOnConnectionError(exc);
      await this.logger.warning(
        `Failed to enqueue result for plan ${args.planId} step ${args.stepName}: ${getErrorMessage(exc)}`,
        { jobId: args.planId },
      );
      return false;
    }
  }

  async enqueueJobCompleted(args: {
    planId: string;
    deviceId: unknown;
    sagaName: string;
    status: string;
    durationSeconds?: number | null;
    error?: string | null;
    metadata?: Record<string, unknown> | null;
  }): Promise<boolean> {
    const queue = await this.queueProvider.getResultsQueue();
    if (queue === null) {
      await this.logger.warning(`Results queue unavailable, cannot send completion for plan ${args.planId}`, {
        jobId: args.planId,
      });
      return false;
    }

    try {
      const payload = buildJobCompletedPayload({
        plan_id: args.planId,
        device_id: args.deviceId,
        saga_name: args.sagaName,
        status: args.status,
        zone_prefix: this.getZonePrefix(),
        duration_seconds: args.durationSeconds,
        error: args.error,
        metadata: args.metadata,
        timestamp: nowSeconds(),
      });
      await queue.add(RESULT_JOB_NAME.JOB_COMPLETED, this.seal({ ...payload }, queue.name, args.planId), REMOVE_OPTS);
      await this.logger.info(`Job completion enqueued: plan=${args.planId} status=${args.status}`, {
        jobId: args.planId,
      });
      return true;
    } catch (exc) {
      await this.queueProvider.resetSharedOpsStateOnConnectionError(exc);
      await this.logger.warning(`Failed to enqueue job completion for plan ${args.planId}: ${getErrorMessage(exc)}`, {
        jobId: args.planId,
      });
      return false;
    }
  }
}
