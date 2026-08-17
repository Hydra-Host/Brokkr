import { Injectable } from '@nestjs/common';

import { NonRetryableSagaError } from '../../saga-framework/saga-runner.service';
import type { SagaContext } from '../../saga-framework/saga.types';

interface DeployOrchestrationServiceLike {
  resolveDeployTarget(params: {
    deviceId: string;
    platform: Record<string, unknown>;
    lifecycleData: Record<string, unknown>;
    bootDevice?: string | null;
  }): Promise<Record<string, unknown>>;
}

interface DeployOrchestrationServiceFactoryLike {
  create(jobId: string, options?: { signal?: AbortSignal; workId?: string }): Promise<DeployOrchestrationServiceLike>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
}

function asMapping(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

@Injectable()
export class ResolveDeployTargetStep {
  constructor(
    private readonly factory: DeployOrchestrationServiceFactoryLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    if (ctx.deviceId === null) {
      throw new NonRetryableSagaError('device_id is required for deploy target resolution');
    }

    const payload = ctx.payload;
    const lifecycleData = asMapping(payload['lifecycle_data']);
    const ipxeUrl = lifecycleData['ipxe_url'] ?? null;

    if (ipxeUrl) {
      await this.logger.info(`Custom iPXE URL provided: ${String(ipxeUrl)} — skipping OS deploy steps`, {
        jobId: ctx.jobId,
      });
      return { skipped: true, reason: 'ipxe_url provided', ipxe_url: ipxeUrl };
    }

    const platform = asMapping(payload['platform']);
    const rawBootDevice = payload['boot_device'];
    const bootDevice = typeof rawBootDevice === 'string' ? rawBootDevice : 'pxe';

    const service = await this.factory.create(ctx.jobId, { signal: ctx.signal, workId: ctx.workId });
    return service.resolveDeployTarget({
      deviceId: String(ctx.deviceId),
      platform,
      lifecycleData,
      bootDevice,
    });
  }
}
