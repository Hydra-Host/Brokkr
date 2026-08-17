import { Injectable } from '@nestjs/common';
import { ServerLifecycleStatus } from '@repo/database';
import type { CollectorContext, DeviceMutation } from '../collectors/collector.types';
import type { Composer } from './composer.types';

@Injectable()
export class LifecycleComposer implements Composer {
  readonly name = 'lifecycle';

  async compose(ctx: CollectorContext): Promise<DeviceMutation> {
    const current = ctx.device.server?.lifecycleStatus ?? null;

    if (
      current === ServerLifecycleStatus.DEPROVISIONING ||
      current === ServerLifecycleStatus.INVENTORY ||
      current === ServerLifecycleStatus.OFFLINE
    ) {
      return { deviceUpdate: { server: { update: { lifecycleStatus: ServerLifecycleStatus.INVENTORY } } } };
    }

    return {};
  }
}
