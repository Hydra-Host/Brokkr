import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeviceRole, ServerLifecycleStatus, ServerPowerStatus } from '@repo/database';
import { getBullMqTelemetry } from '@repo/telemetry';
import { Job } from 'bullmq';
import { BridgeInventoryCollectionService } from 'src/brokkr-bridge/lifecycle/inventory-collection.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { INVENTORY_COLLECTION_INTERVAL_MS, INVENTORY_COLLECTION_QUEUE } from './inventory-collection.types';

@Injectable()
@Processor(INVENTORY_COLLECTION_QUEUE, { telemetry: getBullMqTelemetry('brokkr-hub') })
export class InventoryCollectionCron extends WorkerHost implements OnApplicationBootstrap {
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly inventoryCollection: BridgeInventoryCollectionService,
    private readonly configService: ConfigService,
    @Logger(InventoryCollectionCron.name) private readonly logger: LoggerService,
  ) {
    super();
    this.enabled = this.configService.get('INVENTORY_COLLECTION_ENABLED') !== 'false';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) await this.worker.pause();
  }

  async process(_job: Job): Promise<void> {
    if (!this.enabled) throw new Error('Inventory collection is disabled on this instance');

    const startTime = Date.now();

    try {
      const devices = await this.prisma.device.findMany({
        where: {
          role: DeviceRole.Server,
          server: {
            lifecycleStatus: ServerLifecycleStatus.INVENTORY,
            powerStatus: ServerPowerStatus.On,
          },
          deletedAt: null,
        },
        select: {
          id: true,
          zoneId: true,
        },
      });

      if (devices.length === 0) {
        this.logger.debug('No devices eligible for inventory collection');
        return;
      }

      const zoneDevices = new Map<string, typeof devices>();
      for (const device of devices) {
        const zoneId = device.zoneId;
        if (!zoneId) continue;
        if (!zoneDevices.has(zoneId)) zoneDevices.set(zoneId, []);
        zoneDevices.get(zoneId)!.push(device);
      }

      const skippedNoZone = devices.filter((d) => !d.zoneId).length;
      if (skippedNoZone > 0) {
        this.logger.warn(`Skipped ${skippedNoZone} devices with no zone assignment`);
      }

      let enqueued = 0;

      for (const [zoneId, zoneDeviceList] of zoneDevices) {
        for (const device of zoneDeviceList) {
          try {
            await this.inventoryCollection.startInventoryCollection(device.id, zoneId, 'cron');
            enqueued++;
          } catch (error) {
            this.logger.warn(`Failed to enqueue collection for device ${device.id}: ${getErrorMessage(error)}`);
          }
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Inventory collection dispatch completed in ${duration}ms - ${enqueued}/${devices.length} jobs enqueued across ${zoneDevices.size} zones`,
      );
      if (duration > INVENTORY_COLLECTION_INTERVAL_MS) {
        this.logger.warn(
          `Inventory collection sweep took ${duration}ms, exceeding its ${INVENTORY_COLLECTION_INTERVAL_MS}ms interval`,
        );
      }
    } catch (error) {
      this.logger.error(`Inventory collection dispatch failed: ${getErrorMessage(error)}`);
      throw error;
    }
  }
}
