import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { RequestDeviceHealthCheckResponse } from '@repo/api-client';
import { type Prisma, ServerLifecycleStatus } from '@repo/database';
import type { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { BridgeQueueService } from 'src/brokkr-bridge/queue/bridge-queue.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { REDIS_CLIENT } from 'src/common/redis';
import { deviceHealthRequested } from 'src/common/redis/redis-keys';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import {
  buildHealthCheckDispatch,
  HEALTH_CHECK_ELIGIBLE_WHERE,
  HEALTH_CHECK_ROLES,
  healthCheckDeviceSelect,
} from './device-health-check.dispatch';
import { DEVICE_HEALTH_CHECK_INTERVAL_MS } from './device-health-check.types';

const requestDeviceSelect = {
  ...healthCheckDeviceSelect,
  role: true,
  server: { select: { ...healthCheckDeviceSelect.server.select, lifecycleStatus: true } },
} satisfies Prisma.DeviceSelect;

/** Tenant-unscoped on purpose: the caller has already pinned the device and checked its own permission. */
@Injectable()
export class HealthCheckDispatcher {
  constructor(
    @Inject(PrismaClient) private readonly prisma: Pick<PrismaClient, 'device' | 'deviceHealthCheck'>,
    @Inject(REDIS_CLIENT) private readonly redis: Pick<Redis, 'set'>,
    @Inject(DeviceContextService) private readonly deviceContext: Pick<DeviceContextService, 'resolveFromDevice'>,
    @Inject(BridgeQueueService) private readonly bridgeQueue: Pick<BridgeQueueService, 'enqueueSagaJob'>,
    @Inject(ContextService) private readonly contextService: Pick<ContextService, 'buildAuditPayload'>,
    @Logger(HealthCheckDispatcher.name) private readonly logger: Pick<LoggerService, 'log'>,
  ) {}

  async dispatch(deviceId: string): Promise<RequestDeviceHealthCheckResponse> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId, ...HEALTH_CHECK_ELIGIBLE_WHERE },
      select: requestDeviceSelect,
    });
    if (!device) return this.refuseIneligible(deviceId);
    if (!device.zoneId) {
      throw new BadRequestException('This device is not assigned to a zone, so no bridge can probe it');
    }

    // one run costs up to four BMC logins and the bridge never backs off; a rejected credential must be fixed first
    const latest = await this.prisma.deviceHealthCheck.findFirst({
      where: { deviceId },
      orderBy: { testedAt: 'desc' },
      select: { bmcCredsValid: true, testedAt: true },
    });
    if (latest?.bmcCredsValid === false) {
      throw new ConflictException(
        `The stored BMC credential was rejected at ${latest.testedAt.toISOString()}. Update the credential before requesting another check, because each check logs in again`,
      );
    }

    const ttlSeconds = Math.floor(DEVICE_HEALTH_CHECK_INTERVAL_MS / 1000);
    const claimed = await this.redis.set(deviceHealthRequested(deviceId), '1', 'EX', ttlSeconds, 'NX');
    if (claimed !== 'OK') {
      throw new HttpException(
        'A check was requested less than five minutes ago. The scheduled check runs every five minutes',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ctx = await this.deviceContext.resolveFromDevice(device);
    const jobId = `health-request-${randomUUID()}`;
    const { payload, options } = buildHealthCheckDispatch(device, ctx);
    await this.bridgeQueue.enqueueSagaJob(device.zoneId, 'device_health_check', jobId, payload, device.id, options);

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(`Health check requested: device=${deviceId} job=${jobId} actor=${audit.triggeredBy}`);
    return { jobId };
  }

  // the cron's where has already refused this device; the checks only name the clause it missed
  private async refuseIneligible(deviceId: string): Promise<never> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId, deletedAt: null },
      select: requestDeviceSelect,
    });
    if (!device) throw new NotFoundException('Device not found');
    if (device.server?.lifecycleStatus === ServerLifecycleStatus.OFFLINE) {
      throw new BadRequestException('This device is offline, so the bridge cannot probe it');
    }
    if (!HEALTH_CHECK_ROLES.includes(device.role)) {
      throw new BadRequestException(`This device has the ${device.role} role; only servers are probed`);
    }
    if (!device.interfaces.some((iface) => iface.mgmtOnly && iface.ipAddresses.length > 0)) {
      throw new BadRequestException('This device has no management interface address, so the bridge cannot probe it');
    }
    throw new BadRequestException('This device is not eligible for a bridge health check');
  }
}
