import { Inject, Injectable } from '@nestjs/common';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { NetplanRedisWriterService } from './netplan-redis-writer.service';

// Runs after the caller's write committed: the live netplan renders on demand, so dropping the atom is enough, and a Redis or Prisma hiccup must not turn the committed write into a 500 (the atom TTL heals it).
@Injectable()
export class NetplanLiveInvalidatorService {
  constructor(
    private readonly prisma: PrismaClient,
    @Inject(NetplanRedisWriterService)
    private readonly writer: Pick<NetplanRedisWriterService, 'deleteLive'>,
    @Logger(NetplanLiveInvalidatorService.name) private readonly logger: LoggerService,
  ) {}

  async forDevice(deviceId: string): Promise<void> {
    try {
      const device = await this.prisma.device.findUnique({ where: { id: deviceId }, select: { zoneId: true } });
      if (!device?.zoneId) return;
      await this.writer.deleteLive(device.zoneId, deviceId);
    } catch (error) {
      this.logger.warn(`Live netplan invalidation failed for device ${deviceId}: ${getErrorMessage(error)}`);
    }
  }

  async forInterface(interfaceId: string | null): Promise<void> {
    if (interfaceId == null) return;
    try {
      const iface = await this.prisma.interface.findUnique({
        where: { id: interfaceId },
        select: { deviceId: true, device: { select: { zoneId: true } } },
      });
      if (!iface?.device.zoneId) return;
      await this.writer.deleteLive(iface.device.zoneId, iface.deviceId);
    } catch (error) {
      this.logger.warn(`Live netplan invalidation failed for interface ${interfaceId}: ${getErrorMessage(error)}`);
    }
  }
}
