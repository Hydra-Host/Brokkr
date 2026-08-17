import { Injectable } from '@nestjs/common';

import { NonRetryableSagaError } from '../../saga-framework/saga-runner.service';
import type { SagaContext } from '../../saga-framework/saga.types';

interface DeployOrchestrationServiceLike {
  prepareStorage(params: {
    deviceId: string;
    diskLayouts: Record<string, unknown>[];
    targetPath?: string;
  }): Promise<Record<string, unknown>>;
}

interface DeployOrchestrationServiceFactoryLike {
  create(jobId: string, options?: { signal?: AbortSignal; workId?: string }): Promise<DeployOrchestrationServiceLike>;
}

@Injectable()
export class PrepareStorageStep {
  constructor(private readonly factory: DeployOrchestrationServiceFactoryLike) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    if (ctx.deviceId == null) {
      throw new NonRetryableSagaError('device_id is required for storage preparation');
    }

    const resolveResult = (ctx.stepResults.resolve_deploy_target as Record<string, unknown> | undefined) ?? {};

    if (resolveResult.skipped) {
      return { skipped: true, reason: 'ipxe_url provided' };
    }

    const osPayload = (resolveResult.os_payload as Record<string, unknown> | undefined) ?? {};
    const diskLayouts = (resolveResult.disk_layouts as Record<string, unknown>[] | undefined) ?? [];

    const targetPath = (osPayload.target_path as string | undefined) || '/target';

    const service = await this.factory.create(ctx.jobId, { signal: ctx.signal, workId: ctx.workId });
    return service.prepareStorage({
      deviceId: String(ctx.deviceId),
      diskLayouts,
      targetPath,
    });
  }
}
