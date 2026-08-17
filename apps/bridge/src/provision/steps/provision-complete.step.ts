import { Injectable } from '@nestjs/common';

import type { SagaContext } from '../../saga-framework/saga.types';

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
}

interface ProvisionCompleteResult {
  device_id: unknown;
  platform: Record<string, unknown>;
}

@Injectable()
export class ProvisionCompleteStep {
  constructor(private readonly logger: LoggerLike) {}

  async execute(ctx: SagaContext): Promise<ProvisionCompleteResult> {
    const platform = (ctx.payload.platform as Record<string, unknown> | undefined) ?? {};
    const deviceId = ctx.deviceId;
    const slug = 'slug' in platform ? String(platform.slug) : 'unknown';
    await this.logger.info(`Provision complete for device ${String(deviceId ?? 'unknown')} (platform: ${slug})`, {
      jobId: ctx.jobId,
    });
    return { device_id: deviceId, platform };
  }
}
