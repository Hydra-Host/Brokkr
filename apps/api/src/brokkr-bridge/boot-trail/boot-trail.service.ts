import { Inject, Injectable } from '@nestjs/common';
import type { DeviceBootTrail } from '@repo/api-client';
import { BootTrailReader, type MarkerRedis } from '@repo/device-domain';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { REDIS_CLIENT } from 'src/common/redis';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { PrismaClient } from 'src/prisma/prisma.client';

@Injectable()
export class BootTrailService {
  private readonly reader: BootTrailReader;

  constructor(
    @Inject(REDIS_CLIENT) redis: MarkerRedis,
    @Inject(PrismaClient) prisma: Pick<PrismaClient, 'interface' | 'lifecycleJob'>,
    @Inject(DeviceContextService)
    private readonly deviceContext: Pick<DeviceContextService, 'resolveZoneContext'>,
  ) {
    this.reader = new BootTrailReader(redis, prisma);
  }

  async read(deviceId: string): Promise<DeviceBootTrail> {
    const record = await BaremetalRecord.findByDeviceIdOrThrow(deviceId);
    return this.readForRecord(record);
  }

  async readForRecord(record: BaremetalRecord): Promise<DeviceBootTrail> {
    const deviceId = record.data.id;
    return this.reader.read({
      deviceId,
      zoneId: await this.zoneIdFor(deviceId),
      lifecycleStatus: record.data.server?.lifecycleStatus ?? null,
      statusChangedAt: record.data.server?.updatedAt ?? null,
    });
  }

  // the record pin already proved the device exists, so a resolver failure means no bridge Redis can be read for it
  private async zoneIdFor(deviceId: string): Promise<string | null> {
    try {
      return (await this.deviceContext.resolveZoneContext(deviceId)).zoneId;
    } catch {
      return null;
    }
  }
}
