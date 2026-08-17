import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DeviceTokenRevocationReason, TeeCapability } from '@repo/database';
import { LAYER_SLUGS, LayerRecord, resolveEffectiveBuild } from '@repo/layers';
import { normalizeArchForArtifact } from '@repo/utils';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { isLocalSimulationEnabled } from 'src/common/local-simulation';
import { ConfigAtomWriter, ipxeUrl, TTL_IPXE_URL_SECONDS } from 'src/common/redis';
import { DeviceTokensService } from 'src/device-tokens/device-tokens.service';
import type { DeploymentOsTokenMaterial, IssuedDeviceToken } from 'src/device-tokens/device-tokens.types';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { bmcSecretDispatchFields, DeviceContextService } from '../device-context.service';
import { NetplanPublisherService } from '../netplan/netplan-publisher.service';
import { BridgeQueueService } from '../queue/bridge-queue.service';
import { ServerTokenService } from '../server-token/server-token.service';
import { OsLayerEntry, ProvisionDeviceData, ProvisionLifecycleData } from '../types/lifecycle.types';
import { OsLayersResolverService } from './os-layers-resolver.service';
import { parsePlatformSlug } from './platform-slug';

@Injectable()
export class BridgeProvisionService {
  constructor(
    private readonly bridgeQueueService: BridgeQueueService,
    private readonly deviceContext: DeviceContextService,
    private readonly prisma: PrismaClient,
    private readonly netplanPublisher: NetplanPublisherService,
    private readonly osLayersResolver: OsLayersResolverService,
    private readonly serverTokenService: ServerTokenService,
    private readonly configAtomWriter: ConfigAtomWriter,
    private readonly deviceTokensService: DeviceTokensService,
    @Logger(BridgeProvisionService.name)
    private readonly logger: LoggerService,
  ) {}

  async provisionDevice(
    deviceId: string,
    jobId: string,
    status: 'provisioning' | 'reprovisioning',
    lifecycleData: ProvisionLifecycleData,
    operatingSystemSlug: string,
    deploymentId?: string | null,
    preIssuedDeploymentOsToken?: IssuedDeviceToken<DeploymentOsTokenMaterial>,
  ) {
    this.logger.log(`Resolving device context for ${status} of device ${deviceId}`, jobId);

    const ctx = await this.deviceContext.resolve(deviceId);

    const zone = await this.prisma.zone.findUnique({
      where: { id: ctx.zoneId, deletedAt: null },
      select: { id: true, layerBuildId: true, eastWestNetworkType: true },
    });
    if (!zone) {
      throw new NotFoundException(`Zone ${ctx.zoneId} not found`);
    }
    const layerBuildId = await resolveEffectiveBuild(zone, { Exception: BadRequestException });

    const baseSample = await LayerRecord.findBaseOsSampleBySlug(operatingSystemSlug, layerBuildId);
    const osDistribution = baseSample?.osDistro ?? operatingSystemSlug.split('-')[0];
    const osVersion = baseSample?.osVersion ?? 'latest';
    const platform = parsePlatformSlug(operatingSystemSlug, osDistribution, osVersion);

    // TEE check must precede any state mutation — a late throw would leave netplan/DeploymentLayer/token writes committed with no rollback.
    const teeEnabled = ctx.device.server?.teeEnabled ?? false;
    const teeCapable = ctx.device.server?.teeCapable === TeeCapability.TRUE;
    const teeRequested =
      lifecycleData.tee ||
      platform.variant === 'tee' ||
      (lifecycleData.customizations ?? []).includes(LAYER_SLUGS.tee.TEE_SETUP);
    if (teeRequested && !teeCapable) {
      throw new BadRequestException(
        `TEE was requested but the device is not TEE-capable (variant=${platform.variant})`,
      );
    }

    // The sim normally seeds `Server.netplanOverride` itself and the guest boots from that, so
    // publishing would just echo it back. When the fleet opts into `rendered_netplan` it stops
    // seeding the override, and the publish has to run for real — that is the whole point of the
    // mode. Keying on the override rather than the sim flag keeps the two in step automatically.
    let publishedDeployNetplan: string | null = null;
    const simSeededOverride =
      isLocalSimulationEnabled() && Boolean(ctx.device.server?.netplanOverride ?? ctx.device.netplanOverride);
    if (simSeededOverride) {
      this.logger.warn(`Skipping netplan atom publish for sim device ${deviceId} (jobId=${jobId})`, jobId);
    } else {
      const published = await this.netplanPublisher.publishForProvisioning({
        deviceId: ctx.device.id,
        zonePrefix: ctx.zoneId,
        jobId,
      });
      publishedDeployNetplan = published.deployNetplan;
    }

    const deviceFacts = await this.fetchProvisionDeviceFacts(deviceId);
    const networkType = zone.eastWestNetworkType?.toLowerCase() ?? null;

    const deviceData = await this.buildDeviceData(
      ctx.device.id,
      jobId,
      publishedDeployNetplan,
      deviceFacts,
      networkType,
    );

    let osLayers: OsLayerEntry[] | null = null;
    if (!lifecycleData.ipxeUrl) {
      const arch = normalizeArchForArtifact(ctx.device.cpus[0]?.architecture ?? ctx.device.architecture ?? null);
      const result = await this.osLayersResolver.resolve(
        { layerBuildId, operatingSystemSlug, customizationSlugs: lifecycleData.customizations ?? [], arch },
        jobId,
      );
      osLayers = result.entries;

      if (deploymentId) {
        await this.prisma.$transaction([
          this.prisma.deploymentLayer.deleteMany({ where: { deploymentId } }),
          this.prisma.deploymentLayer.createMany({
            data: result.resolved.map((r) => ({
              deploymentId,
              layerId: r.layerId,
              layerArtifactId: r.layerArtifactId,
            })),
          }),
        ]);
        this.logger.log(`Wrote ${result.resolved.length} DeploymentLayer rows for deployment ${deploymentId}`, jobId);
      }
    }

    const issuedDeploymentOsToken =
      preIssuedDeploymentOsToken ??
      (await this.deviceTokensService.issueDeploymentOsToken({
        deviceId,
        deploymentId: deploymentId ?? null,
        issuedBy: 'system',
      }));

    let mintedBrokkrLiveToken = false;
    let bullmqJobId: string | undefined;
    try {
      const deploymentMaterial = issuedDeploymentOsToken.material;
      if (!deploymentMaterial) {
        throw new BadRequestException('Deployment OS token material is required for provisioning');
      }

      const tokenCtx = {
        device: { id: ctx.device.id },
        zoneId: ctx.zoneId,
      };
      if (lifecycleData.ipxeUrl) {
        const liveAtom = await this.serverTokenService.mintForCtx(tokenCtx);
        mintedBrokkrLiveToken = true;
        await this.serverTokenService.writeAtomBestEffort(tokenCtx, liveAtom, {
          requestId: jobId,
          opLabel: status,
        });

        try {
          await this.configAtomWriter.setString(
            ctx.zoneId,
            ipxeUrl(ctx.device.id),
            lifecycleData.ipxeUrl,
            TTL_IPXE_URL_SECONDS,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to write custom-iPXE url for ${status} of device ${deviceId}: ${getErrorMessage(error)}`,
            jobId,
          );
        }
      } else {
        await this.deviceTokensService.revokeBrokkrLiveTokensForDevice(
          deviceId,
          DeviceTokenRevocationReason.REPROVISION,
          `Non-iPXE ${status} cleared Brokkr Live token material for job ${jobId}`,
        );
      }

      this.logger.log(`Enqueuing ${status} saga for device ${deviceId} (${operatingSystemSlug})`, jobId);

      const job = await this.bridgeQueueService.enqueueSagaJob(
        ctx.zoneId,
        'provision',
        jobId,
        {
          device_id: ctx.device.id,
          bmc_ip: ctx.bmcIp,
          ...bmcSecretDispatchFields(ctx.bmcSecret),
          status,
          tee_enabled: teeEnabled,
          tee_requested: teeRequested,
          boot_device: ctx.device.ipmiBootDeviceOverride ?? 'pxe',
          platform,
          device_data: deviceData,
          lifecycle_data: {
            hostname: lifecycleData.hostname,
            node_desc: `H-${ctx.device.id}`,
            disk_layouts: lifecycleData.diskLayouts,
            pubkeys: lifecycleData.pubkeys,
            user_data: lifecycleData.userData,
            ipxe_url: lifecycleData.ipxeUrl,
            password_hash: lifecycleData.passwordHash ?? null,
            os_layers: osLayers,
            server_token: deploymentMaterial,
          },
        },
        ctx.device.id,
        { removeOnComplete: { count: 0 } },
      );
      bullmqJobId = job.id;
    } catch (error) {
      await this.revokeDeploymentOsTokenAfterProvisionFailure(deviceId, jobId, issuedDeploymentOsToken, error);
      if (mintedBrokkrLiveToken) {
        await this.revokeBrokkrLiveTokenAfterProvisionFailure(deviceId, jobId, error);
      }
      throw error;
    }

    this.logger.log(`${status} saga enqueued: planId=${jobId}, bullmqJobId=${bullmqJobId}`, jobId);
    return { success: true, plan_id: jobId };
  }

  private async revokeDeploymentOsTokenAfterProvisionFailure(
    deviceId: string,
    jobId: string,
    deploymentOsToken: IssuedDeviceToken<DeploymentOsTokenMaterial>,
    provisionError: unknown,
  ): Promise<void> {
    try {
      await this.deviceTokensService.revokeToken({
        tokenId: deploymentOsToken.tokenId,
        reason: DeviceTokenRevocationReason.REPROVISION,
        note: `Provision job ${jobId} failed before bridge enqueue: ${getErrorMessage(provisionError)}`,
        actor: 'system',
      });
    } catch (error) {
      this.logger.warn(
        `Failed to revoke deployment OS token ${deploymentOsToken.displayId} after provision job ${jobId} failed for device ${deviceId}: ${getErrorMessage(
          error,
        )}`,
        jobId,
      );
    }
  }

  private async revokeBrokkrLiveTokenAfterProvisionFailure(
    deviceId: string,
    jobId: string,
    provisionError: unknown,
  ): Promise<void> {
    try {
      await this.deviceTokensService.revokeBrokkrLiveTokensForDevice(
        deviceId,
        DeviceTokenRevocationReason.REPROVISION,
        `Provision job ${jobId} failed after Brokkr Live token mint: ${getErrorMessage(provisionError)}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to revoke Brokkr Live token after provision job ${jobId} failed for device ${deviceId}: ${getErrorMessage(
          error,
        )}`,
        jobId,
      );
    }
  }

  private async buildDeviceData(
    deviceId: string,
    jobId: string,
    publishedDeployNetplan: string | null,
    deviceFacts: ProvisionDeviceFacts,
    networkType: string | null,
  ): Promise<ProvisionDeviceData> {
    const base = {
      gpu_model: deviceFacts.gpuModel,
      purge_ttys: deviceFacts.purgeTtys ?? false,
      serial_port: deviceFacts.serialPort,
      serial_baud: deviceFacts.serialBaud,
      device_type: deviceFacts.deviceType,
      network_type: networkType,
    };

    if (publishedDeployNetplan !== null) {
      return { netplan: publishedDeployNetplan, ...base };
    }
    try {
      const netplan = await this.netplanPublisher.renderDeployNetplan({
        deviceId,
        jobId,
      });
      return { netplan, ...base };
    } catch (error) {
      this.logger.warn(
        `Failed to render deploy netplan for device ${deviceId} payload (shipping netplan:null; spoke will abort the deploy non-retryably): ${getErrorMessage(error)}`,
        jobId,
      );
      return { netplan: null, ...base };
    }
  }

  private async fetchProvisionDeviceFacts(deviceId: string): Promise<ProvisionDeviceFacts> {
    const row = await this.prisma.device.findUnique({
      where: { id: deviceId, deletedAt: null },
      select: {
        gpus: { select: { model: true }, orderBy: { index: 'asc' }, take: 1 },
        server: { select: { purgeTtys: true } },
        deviceModel: { select: { slug: true } },
        solConfig: { select: { optimalPort: true, baudRate: true, resolvedPort: true, resolvedBaud: true } },
      },
    });
    if (!row) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }
    const sol = row.solConfig;
    return {
      gpuModel: row.gpus[0]?.model ?? null,
      purgeTtys: row.server?.purgeTtys ?? null,
      deviceType: row.deviceModel?.slug ?? null,
      serialPort: sol?.resolvedPort ?? sol?.optimalPort ?? null,
      serialBaud: sol?.resolvedBaud ?? sol?.baudRate ?? null,
    };
  }
}

interface ProvisionDeviceFacts {
  gpuModel: string | null;
  purgeTtys: boolean | null;
  serialPort: string | null;
  serialBaud: number | null;
  deviceType: string | null;
}
