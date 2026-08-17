import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../../saga-framework/saga.types';
import { credsFromContext } from '../../steps/power-control-context';

interface RedfishOperationsLike {
  redfishStandardize(
    deviceId: string,
    bmcIp: string,
    username: string,
    password: string,
    jobId: string,
  ): Promise<Record<string, unknown>>;
}

@Injectable()
export class RedfishStandardizeStep {
  constructor(private readonly redfish: RedfishOperationsLike) {}

  async execute(ctx: SagaContext): Promise<{ bios_params: Record<string, unknown> }> {
    const { bmcIp, username, password } = credsFromContext(ctx);
    const biosParams = await this.redfish.redfishStandardize(
      String(ctx.deviceId),
      bmcIp,
      username,
      password,
      ctx.jobId,
    );
    return { bios_params: biosParams };
  }
}
