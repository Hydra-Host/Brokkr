import { Injectable } from '@nestjs/common';
import { isIpxeCustomOs, isRecord } from '@repo/utils';

import { deviceIpxeUrl } from '../../common/redis/redis-keys';
import { NonRetryableSagaError } from '../../saga-framework/saga-runner.service';
import type { SagaContext } from '../../saga-framework/saga.types';

const CUSTOM_IPXE_BOOT_TTL_SECONDS = 21_600;

interface CustomIpxeBootCache {
  set(key: string, value: string, ttl?: number, jobId?: string): Promise<unknown>;
}

@Injectable()
export class ArmCustomIpxeBootStep {
  constructor(private readonly cache: CustomIpxeBootCache) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown>> {
    const platform = ctx.payload['platform'];
    if (!isRecord(platform) || !isIpxeCustomOs(platform['slug'])) {
      return { skipped: true, reason: 'platform is not a custom iPXE OS' };
    }

    const lifecycleData = ctx.payload['lifecycle_data'];
    const ipxeUrl = isRecord(lifecycleData) ? lifecycleData['ipxe_url'] : null;
    if (typeof ipxeUrl !== 'string' || ipxeUrl.length === 0) {
      return { skipped: true, reason: 'ipxe_url is missing' };
    }

    if (typeof ctx.deviceId !== 'string' || ctx.deviceId.length === 0) {
      throw new NonRetryableSagaError('device_id is required to arm custom iPXE boot');
    }

    await this.cache.set(deviceIpxeUrl(ctx.deviceId), ipxeUrl, CUSTOM_IPXE_BOOT_TTL_SECONDS, ctx.jobId);
    return { armed: true };
  }
}
