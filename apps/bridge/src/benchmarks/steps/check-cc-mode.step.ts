import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../saga-framework/saga.types';

interface BenchmarkServiceLike {
  checkCcMode(deviceId: string): Promise<Record<string, unknown> | null>;
}

interface BenchmarkServiceFactoryLike {
  create(jobId: string, options?: { signal?: AbortSignal; workId?: string }): Promise<BenchmarkServiceLike>;
}

@Injectable()
export class CheckCcModeStep {
  constructor(private readonly factory: BenchmarkServiceFactoryLike) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown> | null> {
    const service = await this.factory.create(ctx.jobId, { signal: ctx.signal, workId: ctx.workId });
    return service.checkCcMode(String(ctx.deviceId));
  }
}
