import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isOwnerCapable, permissionKey } from '@repo/auth/rbac';
import { DeploymentType, JobStatus, JobType, LayerKind } from '@repo/database';
import { LayerRecord } from '@repo/layers';
import { Logger } from 'src/common/decorators/logger.decorator';
import { toJsonRecord } from 'src/common/json-utils';
import { LoggerService } from 'src/logger/logger.service';
import { MAIN_APP_PERMISSIONS } from 'src/permissions/permissions.constants';
import { PrismaClient } from 'src/prisma/prisma.client';
import { z } from 'zod';
import { bmcSecretDispatchFields, DeviceContextService, extractBmcIp } from '../device-context.service';
import { BridgeQueueService } from '../queue/bridge-queue.service';
import type { StorageLayoutData } from '../types/discovery-processors.types';
import { LifecyclePreparationService } from './lifecycle-preparation.service';
import { BridgeProvisionService } from './provision.service';

const DEFAULT_QUALIFY_BASE_LAYER_SLUG = 'ubuntu-24.04';

const storageConfigSchema = z.object({
  disk_group_name: z.string().optional(),
  disk_type: z.string().optional(),
  size_per_disk: z.number().optional(),
  disks: z
    .array(
      z.object({
        wwn: z.string().nullish(),
        serial: z.string().nullish(),
        name: z.string().nullish(),
      }),
    )
    .optional(),
});

const storageLayoutSchema = z.object({
  configs: z.array(storageConfigSchema),
  default: z
    .object({
      os_disks_group: z.object({ group: z.string() }).nullish(),
    })
    .nullish(),
});

@Injectable()
export class BridgeCommissioningService {
  constructor(
    private readonly bridgeQueueService: BridgeQueueService,
    private readonly bridgeProvisionService: BridgeProvisionService,
    private readonly lifecyclePrep: LifecyclePreparationService,
    private readonly deviceContextSvc: DeviceContextService,
    private readonly prisma: PrismaClient,
    private readonly configService: ConfigService,
    @Logger(BridgeCommissioningService.name)
    private readonly logger: LoggerService,
  ) {}

  async commissionDevice(
    deviceId: string,
    jobId: string,
    storageLayouts: Record<string, unknown>,
    zoneId: string,
    deviceContext?: { bmcIp: string; ipmiBootDeviceOverride?: string | null },
  ) {
    this.logger.log(`Resolving bridge for commissioning of device ${deviceId} in zone ${zoneId}`, jobId);

    const ctx = await this.deviceContextSvc.resolve(deviceId);

    let bmcIp = ctx.bmcIp;
    let ipmiBootDeviceOverride = ctx.device.ipmiBootDeviceOverride;
    if (deviceContext) {
      const overrideBmcIp = extractBmcIp(deviceContext.bmcIp);
      if (!overrideBmcIp) {
        throw new BadRequestException(`Device ${deviceId} override has no valid IPv4 IPMI address`);
      }
      bmcIp = overrideBmcIp;
      ipmiBootDeviceOverride = deviceContext.ipmiBootDeviceOverride ?? null;
    }

    this.logger.log(`Enqueuing commission saga for device ${deviceId}`, jobId);

    const job = await this.bridgeQueueService.enqueueSagaJob(
      zoneId,
      'commission',
      jobId,
      {
        device_id: ctx.device.id,
        bmc_ip: bmcIp,
        ...bmcSecretDispatchFields(ctx.bmcSecret),
        boot_device: ipmiBootDeviceOverride ?? 'pxe',
        storage_layouts: storageLayouts,
      },
      ctx.device.id,
    );

    this.logger.log(`Commission saga enqueued: planId=${jobId}, bullmqJobId=${job.id}`, jobId);
    return { success: true, plan_id: jobId };
  }

  async enqueueQualifyProvision(
    deviceId: string,
    jobId: string,
    storageLayoutsFromDiscovery?: StorageLayoutData | null,
  ) {
    this.logger.log(`Enqueuing qualify provision for device ${deviceId}`, jobId);

    const operatingSystemSlug = this.configService.get<string>('QUALIFY_OS_SLUG') ?? DEFAULT_QUALIFY_BASE_LAYER_SLUG;

    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      select: {
        id: true,
        supplierId: true,
        zone: { select: { organizationId: true } },
        server: { select: { id: true, storageLayouts: true } },
      },
    });

    if (!device) {
      throw new BadRequestException(`Device ${deviceId} not found`);
    }

    const layoutsForParsing = storageLayoutsFromDiscovery
      ? (storageLayoutsFromDiscovery as unknown as Record<string, unknown>)
      : toJsonRecord(device.server?.storageLayouts ?? null);
    const diskLayouts = this.buildTestDiskLayouts(layoutsForParsing);

    if (diskLayouts.length === 0) {
      throw new BadRequestException(`Device ${deviceId} has no storage layouts that qualify for provision`);
    }

    await this.prisma.job.create({
      data: {
        id: jobId,
        jobType: JobType.Provision,
        device: { connect: { id: device.id } },
        job: { operatingSystemSlug },
        status: JobStatus.Completed,
      },
    });

    const deploymentId = await this.createQualifyDeployment(device, operatingSystemSlug, jobId);

    await this.lifecyclePrep.prepareForProvision(deviceId, jobId);

    const hostnameId = deviceId;
    return this.bridgeProvisionService.provisionDevice(
      deviceId,
      jobId,
      'provisioning',
      {
        hostname: `commission-test-${hostnameId}`,
        diskLayouts,
        pubkeys: [],
        userData: null,
        ipxeUrl: null,
        passwordHash: null,
        customizations: null,
      },
      operatingSystemSlug,
      deploymentId,
    );
  }

  private async createQualifyDeployment(
    device: { id: string; supplierId: string | null; zone: { organizationId: string } | null },
    operatingSystemSlug: string,
    jobId: string,
  ): Promise<string> {
    const baseLayer = await LayerRecord.findBySlug(operatingSystemSlug);
    if (!baseLayer) {
      throw new BadRequestException(
        `Operating system ${operatingSystemSlug} not found for qualify deployment — run seed-from-manifest to populate the layer catalog`,
      );
    }
    if (baseLayer.kind !== LayerKind.BASE) {
      throw new BadRequestException(
        `Layer ${operatingSystemSlug} is not installable (expected kind=BASE, got ${baseLayer.kind})`,
      );
    }

    const organizationId = device.supplierId ?? device.zone?.organizationId;
    if (!organizationId) {
      throw new BadRequestException(`Device ${device.id} has no owning organization; cannot create qualify deployment`);
    }

    const ownerCandidates = await this.prisma.member.findMany({
      where: {
        organizationId,
        deletedAt: null,
        assignedRole: {
          rolePermissions: {
            some: {
              permission: { resource: 'organization', action: 'manage-owners' },
            },
          },
        },
      },
      select: {
        userId: true,
        assignedRole: {
          select: {
            rolePermissions: {
              select: { permission: { select: { resource: true, action: true } } },
            },
          },
        },
      },
    });
    const owner = ownerCandidates.find(
      ({ assignedRole }) =>
        assignedRole &&
        isOwnerCapable(
          MAIN_APP_PERMISSIONS,
          assignedRole.rolePermissions.map(({ permission }) => permissionKey(permission.resource, permission.action)),
        ),
    );
    if (!owner) {
      throw new BadRequestException(
        `Organization ${organizationId} has no owner-capable member; cannot create qualify deployment`,
      );
    }

    const deployment = await this.prisma.deployment.create({
      data: {
        nickname: `qualify-${device.id}`,
        startDate: new Date(),
        type: DeploymentType.SELF_SERVICE,
        server: { connect: { deviceId: device.id } },
        baseLayer: { connect: { id: baseLayer.id } },
        deployer: { connect: { id: owner.userId } },
        customer: { connect: { id: organizationId } },
      },
      select: { id: true },
    });

    this.logger.log(
      `Created transient qualify deployment ${deployment.id} (${operatingSystemSlug}) for device ${device.id}`,
      jobId,
    );
    return deployment.id;
  }

  private buildTestDiskLayouts(storageLayouts: Record<string, unknown>): Array<Record<string, unknown>> {
    const parsed = storageLayoutSchema.safeParse(storageLayouts);
    if (!parsed.success) {
      this.logger.log(`Invalid storage layouts for qualify provision: ${parsed.error.message}`);
      return [];
    }

    const osGroupName = parsed.data.default?.os_disks_group?.group;
    const byNamedGroup = osGroupName
      ? parsed.data.configs.filter((config) => config.disk_group_name === osGroupName)
      : [];

    const bySize = (a: (typeof parsed.data.configs)[number], b: (typeof parsed.data.configs)[number]) =>
      (a.size_per_disk ?? 0) - (b.size_per_disk ?? 0);
    const ssdNvme = parsed.data.configs
      .filter((config) => config.disk_type === 'nvme' || config.disk_type === 'ssd')
      .sort(bySize);
    const rest = parsed.data.configs.filter((config) => config.disk_type !== 'nvme' && config.disk_type !== 'ssd');

    const configs = osGroupName ? [...byNamedGroup, ...ssdNvme, ...rest] : [...ssdNvme, ...rest];

    for (const config of configs) {
      const diskType = config.disk_type ?? 'nvme';
      const diskInfo = config.disks ?? [];
      const disks: string[] = [];
      diskInfo.forEach((disk) => {
        const identifier = disk.wwn ?? disk.serial ?? disk.name;
        if (identifier && identifier.trim()) {
          disks.push(identifier);
        }
      });

      if (disks.length !== 0) {
        return [
          {
            config: 'lvm',
            format: 'ext4',
            mountpoint: '/',
            diskType,
            disks,
            wipe: true,
          },
        ];
      }
    }

    return [];
  }
}
