import { Injectable } from '@nestjs/common';
import { isRecord } from '@repo/utils';

import type { SagaContext } from '../../saga-framework/saga.types';

import { credsFromContext, skipIfBrokkrLiveReady, type SkipResult } from './power-control-context';
import type { PowerManagementServiceFactoryLike } from './power-management-service.types';

@Injectable()
export class PcSetBootDeviceStep {
  constructor(private readonly factory: PowerManagementServiceFactoryLike) {}

  async execute(ctx: SagaContext): Promise<Record<string, unknown> | SkipResult | null> {
    const skip = skipIfBrokkrLiveReady(ctx);
    if (skip !== null) return skip;
    const bootDevice = ctx.payload['boot_device'] ?? 'pxe';
    const service = await this.factory.create(ctx.jobId);
    // After the custom-iPXE handoff a persistent PXE override re-serves the customer installer on
    // every reboot; one-time hands boot control back to the firmware's own UEFI boot order.
    const armResult = ctx.stepResults['arm_custom_ipxe_boot'];
    const customIpxeHandoff = isRecord(armResult) && armResult['armed'] === true;
    return service.setBootDevice(credsFromContext(ctx), bootDevice, { persistent: !customIpxeHandoff });
  }
}
