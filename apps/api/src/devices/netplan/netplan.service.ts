import { ForbiddenException, Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { DeviceContextBuilder } from '../device-context/device-context.builder';
import { renderNetplanYaml } from './netplan-consolidated';

export type NetplanPhase = 'live' | 'deploy';

/** Resolution order: an operator `netplanOverride` wins outright, else `renderNetplanYaml` picks a
 * render family. `phase` selects in-rescue/discovery (`live`) vs post-provision target OS (`deploy`). */
@Injectable()
export class NetplanService {
  constructor(
    private readonly contextBuilder: DeviceContextBuilder,
    private readonly contextService: ContextService,
    private readonly prisma: PrismaClient,
    @Logger(NetplanService.name) private readonly logger: LoggerService,
  ) {}

  // Missing and inaccessible both resolve to 403 to avoid leaking device existence; admins call `renderForDevice` directly.
  async renderForUserDevice(deviceId: string, phase: NetplanPhase = 'live'): Promise<string> {
    const organizationId = this.contextService.organizationId;

    const accessibleDevice = await this.prisma.device.findUnique({
      where: {
        id: deviceId,
        OR: [
          { supplierId: organizationId },
          { organizationId },
          { server: { deployments: { some: { customerId: organizationId, endDate: null } } } },
        ],
      },
      select: { id: true },
    });

    if (!accessibleDevice) {
      throw new ForbiddenException(`You do not have access to device ${deviceId}`);
    }

    return this.renderForDevice(deviceId, phase);
  }

  async renderForDevice(deviceId: string, phase: NetplanPhase = 'live'): Promise<string> {
    const ctx = await this.contextBuilder.build(deviceId);
    this.logger.debug(`Rendering ${phase} netplan for device ${deviceId}`);

    const netplanOverride = ctx.device.server?.netplanOverride ?? ctx.device.netplanOverride;
    if (netplanOverride && netplanOverride.trim().length > 0) {
      return netplanOverride;
    }

    let yaml: string;
    try {
      yaml = renderNetplanYaml(ctx, {
        phase,
        onFallback: (reason) => this.logger.warn(reason),
        onPin: (reason) => this.logger.warn(reason),
      });
    } catch (error) {
      throw new UnprocessableEntityException(`Unable to render ${phase} netplan for device ${deviceId}`, {
        cause: error,
      });
    }

    if (yaml.trim().length === 0) {
      throw new UnprocessableEntityException(`Unable to render ${phase} netplan for device ${deviceId}`);
    }
    return yaml;
  }
}
