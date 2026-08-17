import { Injectable } from '@nestjs/common';
import { ZoneNetworkType } from '@repo/database';
import { Logger } from 'src/common/decorators/logger.decorator';
import { NetplanService } from 'src/devices/netplan/netplan.service';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { NetplanRedisWriterService } from './netplan-redis-writer.service';

export interface PublishForProvisioningParams {
  deviceId: string;
  zonePrefix: string;
  jobId: string;
}

export interface RenderDeployNetplanParams {
  deviceId: string;
  jobId: string;
}

export interface RenderLiveNetplanParams {
  deviceId: string;
  jobId: string;
}

@Injectable()
export class NetplanPublisherService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly netplanService: NetplanService,
    private readonly writer: NetplanRedisWriterService,
    @Logger(NetplanPublisherService.name) private readonly logger: LoggerService,
  ) {}

  async publishForProvisioning(params: PublishForProvisioningParams): Promise<{ deployNetplan: string | null }> {
    const { deviceId, zonePrefix, jobId } = params;

    const isVpc = await this.isVpcDevice(deviceId, jobId);

    this.logger.log(`Rendering :live netplan for device ${deviceId}`, jobId);
    const liveNetplan = await this.renderForDevice(deviceId, 'live');
    const liveResult = await this.writer.set(zonePrefix, deviceId, 'live', liveNetplan);
    if (!liveResult.written) {
      this.logger.warn(
        `live netplan write skipped (${liveResult.reason ?? 'not-written'}) for device ${deviceId} — a newer atom won (jobId=${jobId})`,
        jobId,
      );
    }

    if (!isVpc) {
      this.logger.log(`Non-VPC device ${deviceId}: skipping :deploy netplan publish`, jobId);
      return { deployNetplan: null };
    }

    this.logger.log(`VPC device ${deviceId}: rendering :deploy netplan`, jobId);
    const deployNetplan = await this.renderForDevice(deviceId, 'deploy');
    const deployResult = await this.writer.set(zonePrefix, deviceId, 'deploy', deployNetplan);
    if (!deployResult.written) {
      this.logger.warn(
        `deploy netplan write skipped (${deployResult.reason ?? 'not-written'}) for device ${deviceId} — a newer atom won; tolerated (deploy netplan also rides the saga payload) (jobId=${jobId})`,
        jobId,
      );
    }
    return { deployNetplan };
  }

  async renderDeployNetplan(params: RenderDeployNetplanParams): Promise<string> {
    const { deviceId, jobId } = params;
    this.logger.log(`Rendering deploy netplan for device ${deviceId} payload`, jobId);
    return this.netplanService.renderForDevice(deviceId, 'deploy');
  }

  async renderLiveNetplan(params: RenderLiveNetplanParams): Promise<string> {
    const { deviceId, jobId } = params;
    this.logger.log(`Rendering live netplan for device ${deviceId} on demand`, jobId);
    return this.netplanService.renderForDevice(deviceId, 'live');
  }

  private async renderForDevice(deviceId: string, phase: 'live' | 'deploy'): Promise<string> {
    return this.netplanService.renderForDevice(deviceId, phase);
  }

  private async isVpcDevice(deviceId: string, jobId: string): Promise<boolean> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: { zone: { select: { networkType: true } } },
    });
    if (!device?.zone) {
      this.logger.warn(
        `Device ${deviceId} has no zone — VPC detection skipped, treating as non-VPC (jobId=${jobId})`,
        jobId,
      );
      return false;
    }
    return device.zone.networkType === ZoneNetworkType.VPC;
  }
}
