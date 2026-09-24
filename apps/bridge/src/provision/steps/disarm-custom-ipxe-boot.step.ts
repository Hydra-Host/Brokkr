import { Injectable } from '@nestjs/common';

import { getErrorMessage } from '../../common/error-utils';
import { deviceIpxeUrl } from '../../common/redis/redis-keys';
import { logWarning } from '../../logger/logger.service';
import type { SagaContext } from '../../saga-framework/saga.types';

interface CustomIpxeBootCache {
  delete(key: string, jobId?: string): Promise<number>;
}

@Injectable()
export class DisarmCustomIpxeBootStep {
  constructor(private readonly cache: CustomIpxeBootCache) {}

  // A live marker outranks the hub's discovery override, so Phase 1 would PXE into the customer installer instead of Brokkr Live.
  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    if (typeof ctx.deviceId !== 'string' || ctx.deviceId.length === 0) {
      const reason = 'device_id is missing';
      await logWarning(`Could not disarm custom iPXE boot marker: ${reason}`, { jobId: ctx.jobId });
      return { disarmed: false, reason };
    }

    try {
      await this.cache.delete(deviceIpxeUrl(ctx.deviceId), ctx.jobId);
    } catch (error) {
      // Never fail the provision on this: a failed delete is no worse than not having the step at all.
      const reason = getErrorMessage(error);
      await logWarning(`Could not disarm custom iPXE boot marker: ${reason}`, {
        jobId: ctx.jobId,
        deviceId: ctx.deviceId,
      });
      return { disarmed: false, reason };
    }

    return { disarmed: true };
  }
}
