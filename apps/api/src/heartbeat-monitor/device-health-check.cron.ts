import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeviceRole, Prisma, ServerLifecycleStatus } from '@repo/database';
import { DeviceSpecHelper } from '@repo/device-domain';
import { getBullMqTelemetry } from '@repo/telemetry';
import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import {
  bmcSecretDispatchFields,
  deviceContextSelect,
  DeviceContextService,
  type DeviceContext,
} from 'src/brokkr-bridge/device-context.service';
import { BridgeQueueService } from 'src/brokkr-bridge/queue/bridge-queue.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { DEVICE_HEALTH_CHECK_INTERVAL_MS, DEVICE_HEALTH_CHECK_QUEUE } from './device-health-check.types';

const healthCheckDeviceSelect = {
  ...deviceContextSelect,
  networkType: true,
  interfaces: {
    where: { deletedAt: null },
    include: {
      ipAddresses: {
        where: { deletedAt: null },
        include: { natOutside: { where: { deletedAt: null }, select: { address: true } } },
      },
    },
  },
} satisfies Prisma.DeviceSelect;

@Injectable()
@Processor(DEVICE_HEALTH_CHECK_QUEUE, { telemetry: getBullMqTelemetry('brokkr-hub') })
export class DeviceHealthCheckCron extends WorkerHost implements OnApplicationBootstrap {
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly bridgeQueueService: BridgeQueueService,
    private readonly deviceContext: DeviceContextService,
    private readonly configService: ConfigService,
    @Logger(DeviceHealthCheckCron.name) private readonly logger: LoggerService,
  ) {
    super();
    this.enabled = this.configService.get('DEVICE_HEALTH_CHECK_ENABLED') !== 'false';
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) await this.worker.pause();
  }

  async process(_job: Job): Promise<void> {
    if (!this.enabled) throw new Error('Device health check is disabled on this instance');

    const startTime = Date.now();

    try {
      const devices = await this.prisma.device.findMany({
        where: {
          deletedAt: null,
          NOT: { server: { lifecycleStatus: ServerLifecycleStatus.OFFLINE } },
          // canonical role for new rows is Server; Baremetal is the legacy import value
          role: { in: [DeviceRole.Baremetal, DeviceRole.Server] },
          interfaces: { some: { mgmtOnly: true, deletedAt: null, ipAddresses: { some: { deletedAt: null } } } },
        },
        select: healthCheckDeviceSelect,
      });

      if (devices.length === 0) {
        this.logger.debug('No devices eligible for health checks');
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
          const jobId = `health-cron-${randomUUID()}`;

          let ctx: DeviceContext;
          try {
            ctx = await this.deviceContext.resolveFromDevice(device);
          } catch (error) {
            this.logger.debug(`Skipping health check for device ${device.id}: ${getErrorMessage(error)}`);
            continue;
          }

          try {
            await this.bridgeQueueService.enqueueSagaJob(
              zoneId,
              'device_health_check',
              jobId,
              {
                device_id: device.id,
                bmc_ip: ctx.bmcIp,
                primary_ip:
                  DeviceSpecHelper.ipv4({ networkType: device.networkType, interfaces: device.interfaces }) || null,
                ...bmcSecretDispatchFields(ctx.bmcSecret),
              },
              device.id,
              {
                removeOnComplete: { age: 60 },
                removeOnFail: { age: 600 },
                coalesceKey: `health-cron-${device.id}`,
              },
            );
            enqueued++;
          } catch (error) {
            this.logger.warn(`Failed to enqueue health check for device ${device.id}: ${getErrorMessage(error)}`);
          }
        }
      }

      const duration = Date.now() - startTime;
      this.logger.log(
        `Device health check dispatch completed in ${duration}ms - ${enqueued}/${devices.length} jobs enqueued across ${zoneDevices.size} zones`,
      );
      if (duration > DEVICE_HEALTH_CHECK_INTERVAL_MS) {
        this.logger.warn(
          `Device health check sweep took ${duration}ms, exceeding its ${DEVICE_HEALTH_CHECK_INTERVAL_MS}ms interval`,
        );
      }
    } catch (error) {
      this.logger.error(`Device health check dispatch failed: ${getErrorMessage(error)}`);
      throw error;
    }
  }
}
