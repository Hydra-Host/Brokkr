import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../saga-framework/saga.types';

import { credsFromContext, skipIfBrokkrLiveReady, type SkipResult } from './power-control-context';
import type { PowerManagementServiceFactoryLike } from './power-management-service.types';

@Injectable()
export class PcVerifyBootDeviceStep {
  constructor(private readonly factory: PowerManagementServiceFactoryLike) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown> | SkipResult | null> {
    const skip = skipIfBrokkrLiveReady(ctx);
    if (skip !== null) return skip;
    const bootDevice = ctx.payload['boot_device'] ?? 'pxe';
    const service = await this.factory.create(ctx.jobId);
    return service.verifyBootDevice(credsFromContext(ctx), bootDevice);
  }
}
