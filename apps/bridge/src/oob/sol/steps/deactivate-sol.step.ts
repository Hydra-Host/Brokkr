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

@Injectable()
export class DeactivateSolStep {
  constructor(private readonly factory: SolServiceFactoryLike) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    const { jobId } = ctx;
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
