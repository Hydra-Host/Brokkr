import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../../saga-framework/saga.types';
import { credsFromContext } from '../../steps/power-control-context';

interface SolServiceLike {
  deactivateSession(params: {
    ipAddress: string;
    username: string;
    password: string;
    port?: unknown;
    deviceId?: unknown;
  }): Promise<Record<string, unknown>>;
}

interface SolServiceFactoryLike {
  create(jobId: string): Promise<SolServiceLike>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
}

interface SimModeProbe {
  isLocalSimulationEnabled(): boolean;
}

@Injectable()
export class DeactivateSolStep {
  constructor(
    private readonly factory: SolServiceFactoryLike,
    private readonly logger: LoggerLike,
    private readonly simMode: SimModeProbe,
  ) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    const { jobId } = ctx;

    if (this.simMode.isLocalSimulationEnabled()) {
      await this.logger.info('[sim] SOL deactivation skipped', { jobId });
      return { deactivated: false, reason: 'local_simulation_enabled' };
    }

    const payload = ctx.payload;
    const { bmcIp, username, password } = credsFromContext(ctx);
    const service = await this.factory.create(jobId);

    return service.deactivateSession({
      ipAddress: bmcIp,
      username,
      password,
      port: 'port' in payload ? payload['port'] : 623,
      deviceId: payload['device_id'],
    });
  }
}
