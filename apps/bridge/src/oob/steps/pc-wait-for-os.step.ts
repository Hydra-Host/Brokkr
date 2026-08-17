import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../saga-framework/saga.types';

import type { BrokkrLiveReadinessServiceFactoryLike, StepLoggerLike } from './power-management-service.types';

type SkipResult = { skipped: true; reason: string };
type ReadyResult = { os_ready: true };

@Injectable()
export class PcWaitForOsStep {
  constructor(
    private readonly factory: BrokkrLiveReadinessServiceFactoryLike,
    private readonly logger: StepLoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<SkipResult | ReadyResult> {
    const bootTarget = ctx.payload['boot_target'] ?? 'os';
    if (bootTarget !== 'brokkr_live') {
      const display = String(bootTarget);
      await this.logger.info(`Skipping OS wait (boot_target=${display})`, { jobId: ctx.jobId });
      return { skipped: true, reason: `boot_target is ${display}` };
    }

    const jobId = ctx.jobId;
    await this.logger.info('Waiting for Brokkr Live OS', { jobId });

    const service = await this.factory.create(jobId);
    const ready = await service.waitForBrokkrLive(String(ctx.deviceId));

    if (!ready) {
      throw new Error('Brokkr Live OS did not become ready');
    }

    await this.logger.info('Brokkr Live OS ready', { jobId });
    return { os_ready: true };
  }
}
