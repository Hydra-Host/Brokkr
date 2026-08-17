import { Injectable } from '@nestjs/common';
import { getErrorMessage } from '../../common/error-utils';

import type { SagaContext } from '../../saga-framework/saga.types';
import { syncDiscoveryImages, type SyncVersionCache } from '../discovery-sync';

type SyncFn = (cache: SyncVersionCache, jobId: string, options: { force?: boolean }) => Promise<void>;

interface LoggerLike {
  info(message: string, context?: { jobId?: string }): Promise<void>;
  error(message: string, context?: { jobId?: string }): Promise<void>;
}

interface SyncStepResult {
  success: boolean;
  error?: string;
  sync_type?: unknown;
  forced?: unknown;
}

@Injectable()
export class SyncStep {
  private readonly syncFn: SyncFn;

  constructor(
    private readonly cache: SyncVersionCache,
    private readonly logger: LoggerLike,
    syncFn: SyncFn = syncDiscoveryImages,
  ) {
    this.syncFn = syncFn;
  }

  async execute(ctx: SagaContext): Promise<SyncStepResult> {
    const syncType = 'sync_type' in ctx.payload ? ctx.payload['sync_type'] : 'discovery';
    const force = 'force' in ctx.payload ? Boolean(ctx.payload['force']) : false;

    if (syncType !== 'discovery') {
      return { success: false, error: `Unknown sync type: ${String(syncType)}` };
    }

    try {
      await this.logger.info('Starting discovery sync via saga', { jobId: ctx.jobId });
      await this.syncFn(this.cache, ctx.jobId, { force });
      await this.logger.info('Discovery sync completed via saga', { jobId: ctx.jobId });
      return { success: true, sync_type: syncType, forced: force };
    } catch (error) {
      await this.logger.error(`${String(syncType)} sync failed: ${getErrorMessage(error)}`, { jobId: ctx.jobId });
      throw error;
    }
  }
}
