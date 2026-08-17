import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  type CommissionServerRequest,
  type IpxeBuildTarget,
  type ProvisionServerRequest,
  type ServerFilterOptions,
  type ServersQuery,
  type UpdateListingRequest,
  type UpdateServerInfoRequest,
} from '@repo/api-client';
import {
  DeviceSecretActorType,
  DeviceSecretKind,
  DeviceSecretPurpose,
  JobType,
  WebhookEventType,
} from '@repo/database';
import { ServerSpecHelper } from '@repo/device-domain';
import {
  buildCustomizationCatalog,
  emptyCustomizationCatalog,
  resolveZoneBuildId,
  type CustomizationCatalog,
} from '@repo/layers';
import { mibSizesToGib, normalizeArchForArtifact } from '@repo/utils';
import { DhcpConfigPublisherService } from 'src/brokkr-bridge/dhcp/dhcp-config-publisher.service';
import { BridgeCommissioningService } from 'src/brokkr-bridge/lifecycle/commissioning.service';
import { BridgeInventoryCollectionService } from 'src/brokkr-bridge/lifecycle/inventory-collection.service';
import { CloudInitTemplatesService } from 'src/cloud-init-templates/cloud-init-templates.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { DeviceAggregate } from 'src/common/device.types';
import { getErrorMessage } from 'src/common/error-utils';
import { softDeleteDeviceNetworkAndSecrets } from 'src/common/ipam/soft-delete-device-network';
import { DeviceSecretService, SecretStorageUnavailableError } from 'src/device-secret/device-secret.service';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { InventoryService } from 'src/inventory/inventory.service';
import { LifecycleService } from 'src/lifecycle/lifecycle.service';
import { LoggerService } from 'src/logger/logger.service';
import { OrganizationsService } from 'src/organizations/organizations.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { assertTeeAllowed, isTeeRequested } from 'src/provision/assert-tee-allowed';
import { CloudInitProcessor, flattenCustomizations, ProvisionValidatorService } from 'src/provision/processors';
import { BaremetalPresenter } from './baremetal.presenter';
import { DeviceLifecycleEvent } from './device-lifecycle.events';

@Injectable()
export class BaremetalService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly bridgeCommissioningService: BridgeCommissioningService,
    private readonly bridgeInventoryCollectionService: BridgeInventoryCollectionService,
    private readonly organizationsService: OrganizationsService,
    private readonly inventoryService: InventoryService,
    private readonly contextService: ContextService,
    private readonly lifecycleService: LifecycleService,
    private readonly cloudInitProcessor: CloudInitProcessor,
    private readonly provisionValidator: ProvisionValidatorService,
    private readonly cloudInitTemplatesService: CloudInitTemplatesService,
    private readonly eventEmitter: EventEmitter2,
    private readonly deviceSecretService: DeviceSecretService,
    private readonly dhcpPublisher: DhcpConfigPublisherService,
    @Logger(BaremetalService.name) private readonly logger: LoggerService,
  ) {}

  async getBaremetalServerById(id: string) {
    const record = await BaremetalRecord.findByDeviceId(id, { includeDeleted: true });
    if (!record) {
      throw new NotFoundException('Server not found');
    }
    const hw = ServerSpecHelper.hardwareSummary(record.data);
    let catalog: CustomizationCatalog;
    try {
      const buildId = await resolveZoneBuildId(this.prisma, record.data.zoneId, { Exception: ConflictException });
      catalog = await buildCustomizationCatalog(
        hw.gpuModel,
        ServerSpecHelper.teeCapable(record.data),
        hw.architecture,
        {
          onComponentError: (error) =>
            this.logger.error(`Failed to hydrate customization components for device ${id}: ${getErrorMessage(error)}`),
          buildId: buildId ?? undefined,
        },
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Failed to hydrate customization catalog for device ${id}: ${getErrorMessage(error)}`);
      catalog = emptyCustomizationCatalog();
    }
    return BaremetalPresenter.toResponse(record.data, catalog);
  }

  private async resolveDevice(deviceUuid: string): Promise<BaremetalRecord> {
    return BaremetalRecord.findByDeviceIdOrThrow(deviceUuid);
  }

  private async resolveAggregate(deviceUuid: string): Promise<DeviceAggregate> {
    const record = await this.resolveDevice(deviceUuid);
    return record.data;
  }

  private async findDeviceWithRequiredZone(deviceId: string): Promise<{ record: BaremetalRecord; zoneId: string }> {
    const record = await BaremetalRecord.findByDeviceIdOrThrow(deviceId);
    const { zoneId } = record.data;
    if (!zoneId) {
      throw new BadRequestException('Device is not assigned to a zone');
    }
    return { record, zoneId };
  }

  async getBaremetalServersPaginated(query: ServersQuery) {
    const result = await BaremetalRecord.findPaginated(query, { decommissioned: query.decommissioned ?? false });
    const devices = result.data.map((aggregate) => BaremetalPresenter.toResponse(aggregate));
    return { data: devices, meta: result.meta };
  }

  async getServerFilterOptions(organizationId: string, role?: string): Promise<ServerFilterOptions> {
    const organization = await this.organizationsService.getOrganization({ id: organizationId });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }

    const raw = await BaremetalRecord.getServerFilterOptionsRaw(organizationId, role);

    const sorted = (xs: string[]) => [...xs].sort((a, b) => a.localeCompare(b));
    const sortedNumbers = (xs: number[]) => [...xs].sort((a, b) => a - b);

    return {
      gpuCounts: sortedNumbers(raw.gpuCounts),
      gpuModels: sorted(raw.gpuModels),
      memorySizes: sortedNumbers(mibSizesToGib(raw.memorySizes)),
      statuses: sorted(raw.statuses),
      healthStates: ['Healthy', 'Unhealthy'],
    };
  }

  async commissionDiscoveredServer(commissionDTO: CommissionServerRequest) {
    this.contextService.requirePermission('device', 'create');
    const { record, zoneId } = await this.findDeviceWithRequiredZone(commissionDTO.id);
    const device = record.data;

    // Sealed secret is the sole BMC-cred source at dispatch (fail closed, never plaintext); skipIfLivePresent keeps retries idempotent — rotation goes via the BMC Secrets UI, not re-commission.
    try {
      await this.deviceSecretService.write(
        device.id,
        DeviceSecretPurpose.BMC,
        DeviceSecretKind.USER,
        { user: commissionDTO.ipmiLogin, pass: commissionDTO.ipmiPassword },
        this.contextService.userId,
        { skipIfLivePresent: true },
      );
    } catch (error) {
      if (error instanceof SecretStorageUnavailableError) {
        throw new BadRequestException(
          `Cannot commission device ${device.id}: its zone is not enrolled for secret storage, so BMC ` +
            `credentials cannot be sealed. Enroll the zone before commissioning. (${error.message})`,
        );
      }
      throw error;
    }

    const jobId = crypto.randomUUID();
    await BaremetalRecord.createCommissionJob(commissionDTO, jobId);

    return this.bridgeCommissioningService.commissionDevice(device.id, jobId, {}, zoneId);
  }

  async collectInventory(deviceId: string): Promise<{ jobId: string }> {
    this.contextService.requirePermission('device', 'update');
    const { zoneId } = await this.findDeviceWithRequiredZone(deviceId);
    return this.bridgeInventoryCollectionService.startInventoryCollection(deviceId, zoneId);
  }

  async updateListing(deviceUuid: string, updateFields: UpdateListingRequest) {
    const record = await BaremetalRecord.findByDeviceIdOrThrow(deviceUuid);
    record.updateListing(updateFields);
    await record.save();

    const audit = this.contextService.buildAuditPayload();
    this.logger.log(
      `Device listing ${record.data.id} updated (price/listing fields) | actor=${audit.triggeredByEmail} (${audit.triggeredBy})`,
    );

    await this.inventoryService.tryTriggerListingEvent(WebhookEventType.DEVICE_LISTING_UPDATED, record.data.id);

    return BaremetalPresenter.toResponse(record.data);
  }

  async updateNickname(deviceUuid: string, nickname: string) {
    const record = await this.resolveDevice(deviceUuid);
    record.updateNickname(nickname);
    await record.save();
    return BaremetalPresenter.toResponse(record.data);
  }

  async updateServerToDecommissioned(deviceUuid: string) {
    BaremetalRecord.requireAction('decommission');
    const aggregate = await this.resolveAggregate(deviceUuid);
    const activeDeployment = ServerSpecHelper.activeDeployment(aggregate.server?.deployments ?? []);

    try {
      if (activeDeployment) {
        throw new BadRequestException('Cannot decommission device with an active rental. Please end the rental first.');
      }

      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        const record = await BaremetalRecord.findByDeviceIdOrThrow(aggregate.id, { tx });
        record.decommission();
        await record.save({ tx });

        await softDeleteDeviceNetworkAndSecrets(
          tx,
          this.deviceSecretService,
          aggregate.id,
          { type: DeviceSecretActorType.USER, id: this.contextService.userId },
          'DEVICE_DECOMMISSIONED',
          now,
        );
      });

      this.eventEmitter.emit(DeviceLifecycleEvent.SoftDeleted, { deviceId: aggregate.id });

      await this.inventoryService.tryTriggerListingEvent(WebhookEventType.DEVICE_LISTING_DECOMMISSIONED, aggregate.id);

      await BaremetalRecord.createJob({
        deviceId: aggregate.id,
        jobType: JobType.Decommission,
        job: this.contextService.buildAuditPayload(),
      });

      return { success: true };
    } catch (error) {
      this.logger.error(`Failed to update device ${deviceUuid} to decommissioned:`, (error as Error).stack);
      throw error;
    }
  }

  async getEcoModeStatus(deviceUuid: string): Promise<boolean> {
    const record = await this.resolveDevice(deviceUuid);
    return record.data.server.ecoMode;
  }

  private async updateEcoMode(deviceId: string, value: boolean) {
    await this.prisma.server.update({ where: { deviceId }, data: { ecoMode: value } });
  }

  async updateServerInfo(deviceUuid: string, updateFields: UpdateServerInfoRequest) {
    this.contextService.requirePermission('device', 'update');
    const record = await this.resolveDevice(deviceUuid);

    const promises: Promise<any>[] = [];

    if (updateFields.nickname !== undefined) {
      record.updateNickname(updateFields.nickname);
      promises.push(record.save());
    }

    if (updateFields.ecoMode !== undefined) {
      promises.push(this.updateEcoMode(record.data.id, updateFields.ecoMode));
    }

    if (updateFields.ipxeBuildTarget !== undefined) {
      promises.push(this.updateIpxeBuildTarget(record.data.id, updateFields.ipxeBuildTarget));
    }

    try {
      await Promise.all(promises);
    } catch (error) {
      this.logger.error(`Failed to update device info for device ${deviceUuid}:`, (error as Error).stack);
      throw error;
    }

    // ipxeBuildTarget feeds the per-reservation DHCP atom — republish eagerly so the bridge
    // serves the new bootfile immediately instead of waiting for the reconcile cron.
    if (updateFields.ipxeBuildTarget !== undefined) {
      await this.dhcpPublisher.republishForDevice(record.data.id);
    }
  }

  private async updateIpxeBuildTarget(deviceId: string, value: IpxeBuildTarget | null) {
    await this.prisma.device.update({ where: { id: deviceId }, data: { ipxeBuildTarget: value } });
  }

  async provisionServer(deviceUuid: string, body: ProvisionServerRequest) {
    this.contextService.requirePermission('inventory', 'create');
    const record = await this.resolveDevice(deviceUuid);
    const userId = this.contextService.userId;
    const organizationId = this.contextService.organizationId;

    if (body.diskLayouts) {
      this.provisionValidator.validateDiskLayouts(body.diskLayouts, 'provision');
      this.provisionValidator.validateDiskGroupHomogeneity(body.diskLayouts, record.data.storageDrives ?? []);
    }
    if (body.operatingSystem) {
      this.provisionValidator.validateIpxeRequirements(body.operatingSystem, body.ipxeUrl);
    }

    const hw = ServerSpecHelper.hardwareSummary(record.data);
    const customizations = flattenCustomizations(body.customizations);

    if (isTeeRequested(body.operatingSystem, body.tee, customizations)) {
      assertTeeAllowed(record.data);
    }

    const buildId = await resolveZoneBuildId(this.prisma, record.data.zoneId, {
      strict: true,
      Exception: BadRequestException,
    });
    await this.provisionValidator.validateCustomizations(
      customizations,
      hw.gpuModel,
      ServerSpecHelper.teeCapable(record.data),
      body.operatingSystem,
      normalizeArchForArtifact(hw.architecture),
      buildId,
    );

    const cloudInitContent = await this.cloudInitTemplatesService.resolveAndSave(body);
    const processedCloudInit = this.cloudInitProcessor.process(cloudInitContent);

    return this.lifecycleService.requestProvision({
      deviceId: record.data.id,
      userId,
      organizationId,
      deploymentName: body.deploymentName,
      operatingSystemSlug: body.operatingSystem,
      sshKeyIds: body.sshKeyIds,
      diskLayouts: body.diskLayouts,
      projectId: body.projectId,
      cloudInit: processedCloudInit,
      ipxeUrl: body.ipxeUrl ?? null,
      customizations,
      tee: body.tee ?? false,
      passwordHash: null,
      source: this.contextService.requestSource,
      internalProvision: true,
    });
  }
}
