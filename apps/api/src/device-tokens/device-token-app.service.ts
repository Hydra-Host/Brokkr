import { Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { DeviceTokensService } from './device-tokens.service';

const tokenMetadataSelect = {
  id: true,
  deviceId: true,
  deploymentId: true,
  context: true,
  displayId: true,
  status: true,
  rotationGeneration: true,
  expiresAt: true,
  lastUsedAt: true,
  lastUsedIp: true,
  revokedAt: true,
  revokedReason: true,
  revokedNote: true,
  issuedBy: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class DeviceTokenAppService {
  constructor(
    private readonly contextService: ContextService,
    private readonly deviceTokensService: DeviceTokensService,
    private readonly prisma: PrismaClient,
    @Logger(DeviceTokenAppService.name) private readonly logger: LoggerService,
  ) {}

  async rotateBrokkrLiveTokenForCaller() {
    const deviceIdentity = this.contextService.requireDeviceIdentity;
    const issued = await this.deviceTokensService.rotateBrokkrLiveToken(deviceIdentity.deviceId);

    if (!issued.plaintext || !issued.material) {
      throw new InternalServerErrorException('Rotated Brokkr Live token plaintext is unavailable');
    }
    try {
      await this.deviceTokensService.publishBrokkrLiveTokenMaterial({
        deviceId: deviceIdentity.deviceId,
        material: issued.material,
        requestId: `rotate:${issued.tokenId}`,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to publish rotated Brokkr Live token for device ${deviceIdentity.deviceId}: ${getErrorMessage(error)}`,
        `rotate:${issued.tokenId}`,
      );
    }

    const token = await this.prisma.deviceToken.findUnique({
      where: { id: issued.tokenId },
      select: tokenMetadataSelect,
    });
    if (!token) {
      throw new NotFoundException('Issued device token not found');
    }

    return { token, plaintext: issued.plaintext };
  }
}
