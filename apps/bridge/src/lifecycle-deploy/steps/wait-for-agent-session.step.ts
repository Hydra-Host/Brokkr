import { Injectable } from '@nestjs/common';

import { isRecord } from '@repo/utils';

import type { SagaContext } from '../../saga-framework/saga.types';

const AGENT_RECONNECT_TIMEOUT_S = 180.0;

interface ConnectionHandleLike {
  agentVersion: string;
  connectedAt: number;
}

interface ConnectionRegistryLike {
  get(deviceId: string): ConnectionHandleLike | null;
  waitForRegistration(
    deviceId: string,
    timeoutSec: number,
    opts: { minConnectedAt: number | null },
  ): Promise<ConnectionHandleLike | null>;
  cancelSessionsBefore(deviceId: string, connectedAtSec: number): Promise<number>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
}

interface MonotonicClock {
  now(): number;
}

interface WaitForAgentSessionResult {
  reconnected: boolean;
  waited_s: number;
  agent_version?: string;
}

@Injectable()
export class WaitForAgentSessionStep {
  constructor(
    private readonly registry: ConnectionRegistryLike,
    private readonly logger: LoggerLike,
    private readonly clock: MonotonicClock,
  ) {}

  async execute(ctx: SagaContext): Promise<WaitForAgentSessionResult> {
    const deviceId = String(ctx.deviceId);
    const { jobId } = ctx;
    const hostResetAt = teeConfigHostResetAt(ctx.stepResults);

    const live = this.registry.get(deviceId);
    if (live !== null) {
      if (hostResetAt === null || live.connectedAt >= hostResetAt) {
        await this.evictPreResetSessions(deviceId, hostResetAt, jobId);
        return { reconnected: false, waited_s: 0.0 };
      }
      await this.logger.info(
        `Agent gRPC session on device ${deviceId} predates the host reset by ${(hostResetAt - live.connectedAt).toFixed(0)}s; treating it as stale`,
        { jobId },
      );
    }

    await this.logger.info(
      `Waiting up to ${AGENT_RECONNECT_TIMEOUT_S.toFixed(0)}s for agent gRPC session on device ${deviceId}`,
      { jobId },
    );
    const start = this.clock.now();
    const handle = await this.registry.waitForRegistration(deviceId, AGENT_RECONNECT_TIMEOUT_S, {
      minConnectedAt: hostResetAt,
    });
    const waited = this.clock.now() - start;
    if (handle === null) {
      throw new Error(
        `Agent did not register a gRPC session within ${AGENT_RECONNECT_TIMEOUT_S.toFixed(0)}s for device ${deviceId}`,
      );
    }
    await this.evictPreResetSessions(deviceId, hostResetAt, jobId);

    await this.logger.info(
      `Agent gRPC session live for device ${deviceId} after ${waited.toFixed(1)}s (agent_version=${handle.agentVersion})`,
      { jobId },
    );
    return { reconnected: true, waited_s: waited, agent_version: handle.agentVersion };
  }

  private async evictPreResetSessions(deviceId: string, hostResetAt: number | null, jobId: string): Promise<void> {
    if (hostResetAt === null) return;
    const evicted = await this.registry.cancelSessionsBefore(deviceId, hostResetAt);
    if (evicted > 0) {
      await this.logger.info(
        `Cancelled ${evicted} agent gRPC session(s) on device ${deviceId} connected before the host reset`,
        { jobId },
      );
    }
  }
}

function teeConfigHostResetAt(stepResults: Record<string, unknown>): number | null {
  const teeConfig = stepResults['tee_config'];
  if (!isRecord(teeConfig)) return null;
  const value = teeConfig['host_reset_at'];
  return typeof value === 'number' ? value : null;
}
