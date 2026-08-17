import { Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { bmcSecretDispatchFields, DeviceContextService } from '../device-context.service';
import { BridgeQueueService } from '../queue/bridge-queue.service';
import { ServerTokenService } from '../server-token/server-token.service';

@Injectable()
export class BridgeDeprovisionService {
  constructor(
    private readonly bridgeQueueService: BridgeQueueService,
    private readonly deviceContext: DeviceContextService,
    private readonly serverTokenService: ServerTokenService,
    @Logger(BridgeDeprovisionService.name)
    private readonly logger: LoggerService,
  ) {}

  async deprovisionDevice(deviceId: string, jobId: string) {
    this.logger.log(`Resolving device context for deprovision of device ${deviceId}`, jobId);

    const ctx = await this.deviceContext.resolve(deviceId);

    const tokenCtx = {
      device: { id: ctx.device.id },
      zoneId: ctx.zoneId,
    };
    const tokenAtom = await this.serverTokenService.mintForCtx(tokenCtx);
    await this.serverTokenService.writeAtomBestEffort(tokenCtx, tokenAtom, {
      requestId: jobId,
      opLabel: 'deprovision',
    });

    this.logger.log(`Enqueuing deprovision saga for device ${deviceId}`, jobId);

    const job = await this.bridgeQueueService.enqueueSagaJob(
      ctx.zoneId,
      'deprovision',
      jobId,
      {
        device_id: ctx.device.id,
        bmc_ip: ctx.bmcIp,
        ...bmcSecretDispatchFields(ctx.bmcSecret),
        tee_enabled: ctx.device.server?.teeEnabled ?? false,
        boot_device: ctx.device.ipmiBootDeviceOverride ?? 'pxe',
      },
      ctx.device.id,
      { idempotent: true },
    );

    this.logger.log(`Deprovision saga enqueued: planId=${jobId}, bullmqJobId=${job.id}`, jobId);
    return { success: true, plan_id: jobId };
  }
}
