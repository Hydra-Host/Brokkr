import { ClusterProviderRegistry, PLUGIN_EVENT_BUS, type PluginEventBus } from '@hydrahost/plugin-sdk';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ZoneNetworkType } from '@repo/database';

import { Logger } from '../common/decorators/logger.decorator';
import { getErrorMessage } from '../common/error-utils';
import { LoggerService } from '../logger/logger.service';
import { PrismaClient } from '../prisma/prisma.client';

interface ClusterNetworkTarget {
  zoneId: string;
  organizationId: string;
  provider: string;
}

@Injectable()
export class ClusterNetworkService {
  constructor(
    private readonly prisma: PrismaClient,
    @Inject(PLUGIN_EVENT_BUS) private readonly eventBus: PluginEventBus,
    @Logger(ClusterNetworkService.name) private readonly logger: LoggerService,
  ) {}

  // Fail-closed on a provider error (dispatch/provision fails); clusterable with no SDN provider registered (BOSS without the plugin) warns and proceeds rather than bricking provisions.
  async attach(deploymentId: string, deviceId: string): Promise<void> {
    const target = await this.resolveTarget(deploymentId, deviceId, {
      requireDeployment: true,
      operation: 'attach',
    });
    if (!target) return;

    const provider = ClusterProviderRegistry.resolve(target.provider);
    if (!provider) {
      this.logger.warn(
        `Device ${deviceId} is clusterable in zone ${target.zoneId} but no SDN provider ` +
          `'${target.provider}' is registered — provisioning without cluster networking.`,
      );
      return;
    }

    const result = await provider.attach({
      deploymentId,
      deviceId,
      organizationId: target.organizationId,
      zoneId: target.zoneId,
    });

    this.eventBus.emit('cluster.attached', {
      deploymentId,
      clusterId: result.clusterId,
      organizationId: target.organizationId,
    });
  }

  async detach(deploymentId: string, deviceId: string): Promise<void> {
    const target = await this.resolveTarget(deploymentId, deviceId, {
      requireDeployment: false,
      operation: 'detach',
    });
    if (!target) return;

    const provider = ClusterProviderRegistry.resolve(target.provider);
    if (!provider) return;

    // A detach failure must never block the wipe: a stranded device with tenant data is worse than leaked SDN/IPAM state an operator can reclaim.
    try {
      await provider.detach({ deploymentId, deviceId, organizationId: target.organizationId });
    } catch (error) {
      this.logger.error(
        `SDN detach failed for device ${deviceId} (deployment ${deploymentId}): ${getErrorMessage(error)}`,
      );
      return;
    }

    this.eventBus.emit('cluster.detached', {
      deploymentId,
      clusterId: null,
      organizationId: target.organizationId,
    });
  }

  private async resolveTarget(
    deploymentId: string,
    deviceId: string,
    options: { requireDeployment: boolean; operation: 'attach' | 'detach' },
  ): Promise<ClusterNetworkTarget | null> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        zoneId: true,
        zone: { select: { networkType: true } },
        server: { select: { vpcCapable: true } },
      },
    });

    if (!device?.zoneId) return null;
    if (device.zone?.networkType !== ZoneNetworkType.VPC) return null;
    if (!device.server?.vpcCapable) return null;

    if (!deploymentId) {
      if (options.requireDeployment) {
        throw new BadRequestException(`Missing deployment id for cluster networking on device ${deviceId}`);
      }
      this.logger.warn(`No deployment id for cluster networking on device ${deviceId}`);
      return null;
    }

    const deployment = await this.prisma.deployment.findUnique({
      where: { id: deploymentId },
      select: { customerId: true },
    });
    if (!deployment) {
      if (options.requireDeployment) {
        throw new NotFoundException(`No deployment ${deploymentId} found for cluster networking on device ${deviceId}`);
      }
      this.logger.warn(`No deployment ${deploymentId} found for cluster networking on device ${deviceId}`);
      return null;
    }

    let provider: string | undefined;
    if (options.operation === 'detach') {
      const clusterDeployment = await this.prisma.clusterDeployment.findFirst({
        where: { deploymentId },
        select: { cluster: { select: { provider: true } } },
      });
      provider = clusterDeployment?.cluster.provider;
      if (!provider) {
        const registered = ClusterProviderRegistry.list();
        provider = registered.length === 1 ? registered[0].provider : undefined;
        if (!provider) {
          if (registered.length > 1) {
            this.logger.warn(
              `Multiple SDN providers registered (${registered.map((p) => p.provider).join(', ')}); ` +
                `cannot select one for detach of device ${deviceId} without cluster membership.`,
            );
          }
          return null;
        }
        this.logger.warn(
          `No cluster membership for deployment ${deploymentId}; falling back to provider '${provider}' for detach cleanup`,
        );
      }
    } else {
      const registered = ClusterProviderRegistry.list();
      provider = registered.length === 1 ? registered[0].provider : undefined;
      if (!provider) {
        if (registered.length > 1) {
          this.logger.warn(
            `Multiple SDN providers registered (${registered.map((p) => p.provider).join(', ')}); ` +
              `cannot select one for device ${deviceId} without a Zone.sdnProvider discriminator.`,
          );
        }
        return null;
      }
    }

    return { zoneId: device.zoneId, organizationId: deployment.customerId, provider };
  }
}
