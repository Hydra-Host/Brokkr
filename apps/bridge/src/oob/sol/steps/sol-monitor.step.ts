import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../../saga-framework/saga.types';
import { credsFromContext } from '../../steps/power-control-context';

interface SolServiceLike {
  monitorSession(params: {
    planId: string;
    ipAddress: string;
    username: string;
    password: string;
    port?: unknown;
    timeout?: unknown;
    passStrings?: unknown;
    failStrings?: unknown;
    deviceId?: unknown;
  }): Promise<Record<string, unknown>>;
}

interface SolServiceFactoryLike {
  create(jobId: string): Promise<SolServiceLike>;
}

@Injectable()
export class SolMonitorStep {
  constructor(private readonly factory: SolServiceFactoryLike) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    const { jobId } = ctx;
    const payload = ctx.payload;
    const { bmcIp, username, password } = credsFromContext(ctx);
    const service = await this.factory.create(jobId);

    return service.monitorSession({
      planId: ctx.planId,
      ipAddress: bmcIp,
      username,
      password,
      port: 'port' in payload ? payload['port'] : 623,
      timeout: 'timeout' in payload ? payload['timeout'] : 300,
      passStrings: 'pass_strings' in payload ? payload['pass_strings'] : [' login:'],
      failStrings: 'fail_strings' in payload ? payload['fail_strings'] : ['timeout', 'grub>'],
      deviceId: payload['device_id'],
    });
  }
}
