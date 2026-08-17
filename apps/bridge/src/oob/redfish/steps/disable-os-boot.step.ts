import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../../saga-framework/saga.types';
import { credsFromContext } from '../../steps/power-control-context';

interface RedfishOperationsLike {
  disableOsBootOptions(
    deviceId: string,
    bmcIp: string,
    username: string,
    password: string,
    jobId: string,
  ): Promise<boolean>;
}

@Injectable()
export class DisableOsBootStep {
  constructor(private readonly redfish: RedfishOperationsLike) {}

  async execute(ctx: SagaContext): Promise<{ success: boolean }> {
    const { bmcIp, username, password } = credsFromContext(ctx);
    const success = await this.redfish.disableOsBootOptions(String(ctx.deviceId), bmcIp, username, password, ctx.jobId);
    if (!success) {
      throw new Error('disableOsBootOptions failed: BMC boot options were not disabled');
    }
    return { success };
  }
}
