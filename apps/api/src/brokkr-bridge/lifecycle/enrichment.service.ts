import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { type SealedSecretEnvelope } from 'src/device-secret/device-secret.service';
import { LoggerService } from 'src/logger/logger.service';
import { bmcSecretDispatchFields } from '../device-context.service';
import { BridgeQueueService } from '../queue/bridge-queue.service';

@Injectable()
export class BridgeEnrichmentService {
  constructor(
    private readonly bridgeQueueService: BridgeQueueService,
    @Logger(BridgeEnrichmentService.name)
    private readonly logger: LoggerService,
  ) {}

  async startEnrichment(
    zoneId: string,
    bmcIp: string,
    bmcSecret: SealedSecretEnvelope,
    planId: string,
  ): Promise<{ success: true; planId: string }> {
    const sagaPayload = {
      bmc_ip: bmcIp,
      device_id: planId,
      ...bmcSecretDispatchFields(bmcSecret),
      command: 'reliable_boot',
      boot_device: 'pxe',
    };

    await this.bridgeQueueService.enqueueSagaJob(zoneId, 'enrich_via_pxe', planId, sagaPayload, zoneId);
    this.logger.log(`enrich_via_pxe saga enqueued: zone=${zoneId}, planId=${planId}`, planId);

    return { success: true, planId };
  }
}
