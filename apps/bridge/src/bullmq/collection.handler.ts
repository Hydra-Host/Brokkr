import { Injectable } from '@nestjs/common';
import { getErrorMessage } from '../common/error-utils';

import type { OperationName, OperationOutput } from '@repo/bridge-agent-protocol';

import { AgentNotConnected, DispatchFailed, DispatchTimeout } from '../agent/dispatch/grpc.exceptions';

import type { JobHandler, ProcessableJob } from './handlers.service';

export interface CollectionDispatcherLike {
  dispatchTyped<N extends OperationName>(
    deviceId: string,
    operation: N,
    input: unknown,
    options: { jobId?: string | null; timeoutS?: number | null },
  ): Promise<OperationOutput<N>>;
}

export interface CollectionRegistryLike {
  isConnected(deviceId: string): boolean;
}

export interface CollectionResultsLike {
  clearCollectionData(deviceId: string): Promise<boolean>;
  getCollectionFieldCount(deviceId: string): number | null;
  enqueueDiscoveryComplete(args: { deviceId: string; jobId?: string | null }): Promise<boolean>;
}

export interface CollectionCacheLike {
  exists(key: string, jobId?: string | null): Promise<boolean>;
  delete(key: string, jobId?: string | null): Promise<number>;
}

export interface CollectionCooldownKey {
  cooldownKey(deviceId: string): string;
}

export interface CollectionLogger {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

const COLLECTION_TIMEOUT_S = 600;

function requireKey(obj: Record<string, unknown>, key: string): unknown {
  if (!(key in obj)) {
    const err = new Error(`'${key}'`);
    err.name = 'RecordKeyError';
    throw err;
  }
  return obj[key];
}

function jobIdBoundary(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

@Injectable()
export class CollectionJobHandler {
  constructor(
    private readonly dispatcher: CollectionDispatcherLike,
    private readonly registry: CollectionRegistryLike,
    private readonly results: CollectionResultsLike,
    private readonly cache: CollectionCacheLike,
    private readonly cooldown: CollectionCooldownKey,
    private readonly logger: CollectionLogger,
  ) {}

  readonly handle: JobHandler = async (job) => this.run(job);

  private async run(job: ProcessableJob<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const deviceIdRaw = requireKey(job.data, 'device_id');
    const deviceIdStr = String(deviceIdRaw);
    const planIdRaw = job.data['plan_id'] ?? '';
    const jobIdRaw = job.data['job_id'] ?? '';
    const effectiveJobIdRaw = jobIdRaw !== '' && jobIdRaw != null ? jobIdRaw : planIdRaw;
    const effectiveJobId = jobIdBoundary(effectiveJobIdRaw);

    await this.logger.info(`Starting hardware collection for device ${deviceIdStr}`, {
      jobId: effectiveJobId ?? undefined,
    });

    try {
      if (await this.cache.exists(`lock:device:${deviceIdStr}`, effectiveJobId)) {
        await this.cache.delete(this.cooldown.cooldownKey(deviceIdStr), effectiveJobId);
        await this.logger.info(`Collection deferred for device ${deviceIdStr}: saga lock held (cooldown cleared)`, {
          jobId: effectiveJobId ?? undefined,
        });
        return { device_id: deviceIdRaw, status: 'deferred', reason: 'saga_lock_held' };
      }

      if (!this.registry.isConnected(deviceIdStr)) {
        throw new AgentNotConnected(deviceIdStr);
      }

      await this.results.clearCollectionData(deviceIdStr);

      let summary: OperationOutput<'collection.collectAll'>;
      try {
        summary = await this.dispatcher.dispatchTyped(
          deviceIdStr,
          'collection.collectAll',
          {},
          { jobId: effectiveJobId, timeoutS: COLLECTION_TIMEOUT_S },
        );
      } catch (exc) {
        if (exc instanceof DispatchTimeout) {
          throw new Error(`Collection timed out for device ${deviceIdStr}: ${exc.message}`);
        }
        if (exc instanceof DispatchFailed) {
          throw new Error(`Collection dispatch failed for device ${deviceIdStr}: ${exc.message}`);
        }
        throw exc;
      }

      const agentSuccesses = summary.successes;
      const agentFailures = summary.failures;

      await this.results.enqueueDiscoveryComplete({
        deviceId: deviceIdStr,
        jobId: effectiveJobId ?? undefined,
      });

      const durationMs = summary.total_duration_ms;
      await this.logger.info(
        `Collection complete for device ${deviceIdStr}: agent ${agentSuccesses} ok / ${agentFailures} failed, duration_ms=${String(durationMs)}`,
        { jobId: effectiveJobId },
      );

      return {
        device_id: deviceIdRaw,
        status: 'complete',
        metadata: {
          collectors_total: agentSuccesses + agentFailures,
          collectors_successful: agentSuccesses,
          collectors_failed: agentFailures,
          agent_summary: summary,
        },
      };
    } catch (exc) {
      await this.logger.error(`Collection failed for device ${deviceIdStr}: ${getErrorMessage(exc)}`, {
        jobId: effectiveJobId ?? undefined,
      });
      throw exc;
    }
  }
}
