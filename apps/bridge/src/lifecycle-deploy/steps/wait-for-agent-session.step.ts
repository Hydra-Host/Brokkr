import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../saga-framework/saga.types';

const AGENT_RECONNECT_TIMEOUT_S = 180.0;

interface ConnectionHandleLike {
  agentVersion: string;
}

interface ConnectionRegistryLike {
  isConnected(deviceId: string): boolean;
  waitForRegistration(deviceId: string, timeoutSec: number): Promise<ConnectionHandleLike | null>;
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

    if (this.registry.isConnected(deviceId)) {
      return { reconnected: false, waited_s: 0.0 };
    }

    await this.logger.info(
      `Waiting up to ${AGENT_RECONNECT_TIMEOUT_S.toFixed(0)}s for agent gRPC session on device ${deviceId}`,
      { jobId },
    );
    const start = this.clock.now();
    const handle = await this.registry.waitForRegistration(deviceId, AGENT_RECONNECT_TIMEOUT_S);
    const waited = this.clock.now() - start;
    if (handle === null) {
      throw new Error(
        `Agent did not register a gRPC session within ${AGENT_RECONNECT_TIMEOUT_S.toFixed(0)}s for device ${deviceId}`,
      );
    }

    await this.logger.info(
      `Agent gRPC session live for device ${deviceId} after ${waited.toFixed(1)}s (agent_version=${handle.agentVersion})`,
      { jobId },
    );
    return { reconnected: true, waited_s: waited, agent_version: handle.agentVersion };
  }
}
