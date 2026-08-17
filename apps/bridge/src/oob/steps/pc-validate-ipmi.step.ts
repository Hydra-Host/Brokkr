import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../saga-framework/saga.types';

import { credsFromContext } from './power-control-context';
import type { PowerManagementServiceFactoryLike } from './power-management-service.types';

@Injectable()
export class PcValidateIpmiStep {
  constructor(private readonly factory: PowerManagementServiceFactoryLike) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown> | null> {
    const service = await this.factory.create(ctx.jobId);
    return service.validateCredentials(credsFromContext(ctx));
  }
}
