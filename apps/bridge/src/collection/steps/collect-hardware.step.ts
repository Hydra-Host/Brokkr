import { Injectable } from '@nestjs/common';
import { getErrorMessage } from '../../common/error-utils';

import type { OperationName, OperationOutput } from '@repo/bridge-agent-protocol';

import {
  AgentNotConnected,
  AgentNotResponsive,
  DispatchFailed,
  DispatchTimeout,
} from '../../agent/dispatch/grpc.exceptions';
import type { SagaContext } from '../../saga-framework/saga.types';

interface DispatcherLike {
  dispatchTyped<N extends OperationName>(
    deviceId: string,
    operation: N,
    input: unknown,
    options: { jobId?: string | null; timeoutS?: number | null; signal?: AbortSignal; workId?: string },
  ): Promise<OperationOutput<N>>;
}

interface ConnectionRegistryLike {
  isConnected(deviceId: string): boolean;
}

interface CollectionResultsLike {
  clearCollectionData(deviceId: string): Promise<boolean>;
  getCollectionFieldCount(deviceId: string): number | null;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

type StepResult =
  | {
      collected: true;
      metadata: {
        collectors_total: number;
        collectors_successful: number;
        collectors_failed: number;
        agent_summary: Record<string, unknown>;
      };
    }
  | { collected: false; reason: string }
  | { collected: false; error: string };

const COLLECT_TIMEOUT_S = 600;

@Injectable()
export class CollectHardwareStep {
  constructor(
    private readonly dispatcher: DispatcherLike,
    private readonly registry: ConnectionRegistryLike,
    private readonly results: CollectionResultsLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<StepResult> {
    const deviceId = String(ctx.deviceId);
    const { jobId } = ctx;

    const checkResult = toRecord(ctx.stepResults.brokkr_live_check);
    const waitResult = toRecord(ctx.stepResults.wait_for_brokkr_live);
    const deviceReady = !!checkResult?.ready || !!waitResult?.os_ready;
    if (!deviceReady) {
      await this.logger.warning(`Skipping collection — Brokkr Live not reachable on device ${deviceId}`, { jobId });
      return { collected: false, reason: 'device not reachable' };
    }

    try {
      await this.logger.info(`Starting hardware collection for device ${deviceId}`, { jobId });

      if (!this.registry.isConnected(deviceId)) {
        throw new Error(`Device ${deviceId} has no active agent gRPC session; agent may not be deployed yet`);
      }

      await this.results.clearCollectionData(deviceId);

      const summary = await this.dispatchOrConvert(deviceId, jobId, ctx.signal, ctx.workId);

      const agentSuccesses = summary.successes;
      const agentFailures = summary.failures;

      await this.logger.info(
        `Collection complete for device ${deviceId}: agent ${agentSuccesses} ok / ${agentFailures} failed`,
        { jobId },
      );
      return {
        collected: true,
        metadata: {
          collectors_total: agentSuccesses + agentFailures,
          collectors_successful: agentSuccesses,
          collectors_failed: agentFailures,
          agent_summary: summary,
        },
      };
    } catch (error) {
      if (error instanceof AgentNotConnected || error instanceof AgentNotResponsive) throw error;
      await this.logger.warning(`Hardware collection failed (non-fatal): ${getErrorMessage(error)}`, { jobId });
      return { collected: false, error: getErrorMessage(error) };
    }
  }

  private async dispatchOrConvert(
    deviceId: string,
    jobId: string,
    signal?: AbortSignal,
    workId?: string,
  ): Promise<OperationOutput<'collection.collectAll'>> {
    try {
      return await this.dispatcher.dispatchTyped(
        deviceId,
        'collection.collectAll',
        {},
        {
          jobId,
          timeoutS: COLLECT_TIMEOUT_S,
          signal,
          workId,
        },
      );
    } catch (exc) {
      if (exc instanceof DispatchTimeout) {
        throw new Error(`Collection timed out for device ${deviceId}: ${exc.message}`);
      }
      if (exc instanceof DispatchFailed) {
        throw new Error(`Collection dispatch failed for device ${deviceId}: ${exc.message}`);
      }
      throw exc;
    }
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
