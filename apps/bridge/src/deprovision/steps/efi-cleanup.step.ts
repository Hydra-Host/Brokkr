import { Inject, Injectable } from '@nestjs/common';
import { getErrorMessage } from '../../common/error-utils';

import { EFI_BOOT_SERVICE_FACTORY } from '../../lifecycle-deploy/efi-boot.service';
import type { SagaContext } from '../../saga-framework/saga.types';

interface EfiBootServiceLike {
  cleanupOsBootEntries(): Promise<Record<string, unknown>>;
}

interface EfiBootServiceFactoryLike {
  create(args: { jobId: string; deviceId: string; signal?: AbortSignal; workId?: string }): Promise<EfiBootServiceLike>;
}

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  warning(message: string, context?: { jobId?: string }): Promise<void>;
}

@Injectable()
export class EfiCleanupStep {
  constructor(
    @Inject(EFI_BOOT_SERVICE_FACTORY)
    private readonly factory: EfiBootServiceFactoryLike,
    private readonly logger: LoggerLike,
  ) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    const deviceId = String(ctx.deviceId);
    const { jobId } = ctx;

    await this.logger.info(`Cleaning up EFI boot entries for device ${deviceId}`, { jobId });

    try {
      const efiService = await this.factory.create({
        jobId,
        deviceId,
        signal: ctx.signal,
        workId: ctx.workId,
      });
      const result = await efiService.cleanupOsBootEntries();
      await this.logger.info(`EFI cleanup complete: ${formatResult(result)}`, { jobId });
      return result;
    } catch (error) {
      const message = getErrorMessage(error);
      await this.logger.warning(`EFI cleanup failed (non-fatal): ${message}`, { jobId });
      return { removed: [], count: 0, error: message };
    }
  }
}

function formatResult(result: Record<string, unknown>): string {
  return JSON.stringify(result);
}
