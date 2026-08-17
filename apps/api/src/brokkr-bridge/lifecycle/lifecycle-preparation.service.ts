import { Injectable, NotFoundException } from '@nestjs/common';
import { ServerLifecycleStatus } from '@repo/database';
import { LayerRecord } from '@repo/layers';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { DeviceRecordPublisher } from '../device-record/device-record-publisher.service';
import { NetplanRedisWriterService } from '../netplan/netplan-redis-writer.service';

@Injectable()
export class LifecyclePreparationService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly netplanWriter: NetplanRedisWriterService,
    private readonly deviceRecordPublisher: DeviceRecordPublisher,
    @Logger(LifecyclePreparationService.name)
    private readonly logger: LoggerService,
  ) {}

  async prepareForProvision(deviceId: string, jobId: string): Promise<void> {
    this.logger.log(`Preparing device ${deviceId} for provisioning`, jobId);

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, server: { select: { lifecycleStatus: true } } },
    });

    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }

    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        lastJobId: jobId,
        server: {
          upsert: {
            create: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING },
            update: { lifecycleStatus: ServerLifecycleStatus.PROVISIONING },
          },
        },
      },
    });

    await this.setDeploymentRescueOs(device.id, 'brokkr-discovery', jobId);

    try {
      const result = await this.deviceRecordPublisher.writeForDevice(device.id, { requestId: jobId });
      DeviceRecordPublisher.warnIfPublishSkipped(this.logger, result, 'prepareForProvision', device.id, jobId);
    } catch (error) {
      this.logger.warn(
        `Failed to publish device_record atom after prepareForProvision ${device.id}: ${getErrorMessage(error)}`,
        jobId,
      );
    }

    this.logger.log(`Device ${deviceId} prepared for provisioning`, jobId);
  }

  async prepareForDeprovision(deviceId: string, jobId: string): Promise<void> {
    this.logger.log(`Preparing device ${deviceId} for deprovision`, jobId);

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { id: true, zoneId: true },
    });

    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }

    await this.prisma.device.update({
      where: { id: device.id },
      data: {
        lastJobId: jobId,
        server: {
          upsert: {
            create: { lifecycleStatus: ServerLifecycleStatus.DEPROVISIONING },
            update: { lifecycleStatus: ServerLifecycleStatus.DEPROVISIONING },
          },
        },
      },
    });

    const zoneUuid = device.zoneId;
    if (zoneUuid) {
      await this.netplanWriter.deleteDeploy(zoneUuid, device.id);
      this.logger.log(`Deleted :deploy netplan from Redis for device ${deviceId}`, jobId);
    } else {
      this.logger.warn(`Device ${deviceId} has no zoneId — skipping :deploy netplan deletion`, jobId);
    }

    await this.setDeploymentRescueOs(device.id, 'brokkr-discovery', jobId);
    try {
      const result = await this.deviceRecordPublisher.writeForDevice(device.id, { requestId: jobId });
      DeviceRecordPublisher.warnIfPublishSkipped(this.logger, result, 'prepareForDeprovision', device.id, jobId);
    } catch (error) {
      this.logger.warn(
        `Failed to publish device_record atom after prepareForDeprovision ${device.id}: ${getErrorMessage(error)}`,
        jobId,
      );
    }

    this.logger.log(`Device ${deviceId} prepared for deprovision`, jobId);
  }

  async setDeploymentRescueOs(deviceId: string, osSlug: string | null, jobId: string): Promise<void> {
    const deployment = await this.prisma.deployment.findFirst({
      where: { server: { deviceId }, endDate: null },
      orderBy: { startDate: 'desc' },
      select: { id: true },
    });
    if (!deployment) {
      return;
    }
    let rescueLayerId: string | null = null;
    if (osSlug) {
      const layer = await LayerRecord.findBySlug(osSlug);
      if (!layer) {
        this.logger.warn(`Rescue OS '${osSlug}' not found; deployment ${deployment.id} boot target unchanged`, jobId);
        return;
      }
      rescueLayerId = layer.id;
    }
    await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: { rescueLayerId },
    });
  }
}
