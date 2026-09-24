import {
  BadRequestException,
  ConflictException,
  forwardRef,
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InterruptibleClaimStatus, Prisma, WebhookEventType } from '@repo/database';
import { paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { serverPowerStatusToLegacy, ServerSpecHelper } from '@repo/device-domain';
import {
  buildCustomizationCatalog,
  type CustomizationCatalog,
  emptyCustomizationCatalog,
  resolveZoneBuildId,
} from '@repo/layers';
import { LifecycleJobRecord } from '@repo/lifecycle';
import { normalizeArchForArtifact, TRANSITIONAL_POWER_STATUSES } from '@repo/utils';
import { DeviceContextService } from 'src/brokkr-bridge/device-context.service';
import { SolLogService } from 'src/brokkr-bridge/sol-logs/sol-log.service';
import { CloudInitTemplatesService } from 'src/cloud-init-templates/cloud-init-templates.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { ensureError, getErrorMessage } from 'src/common/error-utils';
import { BaremetalRecord } from 'src/devices/baremetal.record';
import { LifecycleService } from 'src/lifecycle/lifecycle.service';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { assertTeeAllowed, isTeeRequested } from 'src/provision/assert-tee-allowed';
import { CloudInitProcessor, flattenCustomizations, ProvisionValidatorService } from 'src/provision/processors';
import { PowerControlDeploymentJob, RESCUE_OS_SLUG } from 'src/provision/provision.types';
import { WebhookDeliveryService } from 'src/webhook/webhook-delivery.service';
import { WebhookRepository } from 'src/webhook/webhook.repository';
import { WebhookEventDTO } from 'src/webhook/webhook.types';
import { DeploymentProjectRecord } from '../deployment-project.record';
import { DeploymentPresenter } from '../deployment.presenter';
import { DeploymentRecord } from '../deployment.record';
import { RescueModeService } from '../rescue-mode.service';
import {
  CreateDeploymentData,
  DeploymentAggregate,
  ExportLogsJobType,
  ReprovisionDeploymentInput,
  UpdateDeploymentRecordDTO,
} from '../types/deployments.types';

@Injectable()
export class DeploymentsService {
  constructor(
    @Inject(forwardRef(() => LifecycleService))
    private readonly lifecycleService: LifecycleService,
    private readonly prisma: PrismaClient,
    private readonly solLogService: SolLogService,
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly webhookRepo: WebhookRepository,
    private readonly rescueModeService: RescueModeService,
    private readonly deviceContextService: DeviceContextService,
    private readonly contextService: ContextService,
    private readonly cloudInitProcessor: CloudInitProcessor,
    private readonly provisionValidator: ProvisionValidatorService,
    private readonly cloudInitTemplatesService: CloudInitTemplatesService,
    @Logger(DeploymentsService.name) private readonly logger: LoggerService,
  ) {}

  public async createDeployment(data: CreateDeploymentData) {
    const targetProjectId = await this.resolveTargetProjectId(data);
    return DeploymentRecord.createWithRelations({ ...data, projectId: targetProjectId });
  }

  public async getDeploymentById(deploymentId: string) {
    const aggregate = await this.getDeploymentAggregate(deploymentId);
    const device = { ...aggregate.server.device, server: aggregate.server };
    const hw = ServerSpecHelper.hardwareSummary(device);
    let catalog: CustomizationCatalog;
    try {
      const buildId = await resolveZoneBuildId(this.prisma, aggregate.server.device.zoneId, {
        Exception: ConflictException,
      });
      catalog = await buildCustomizationCatalog(hw.gpuModel, ServerSpecHelper.teeCapable(device), hw.architecture, {
        onComponentError: (error) =>
          this.logger.error(
            `Failed to hydrate customization components for deployment ${deploymentId}: ${getErrorMessage(error)}`,
          ),
        buildId: buildId ?? undefined,
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to hydrate customization catalog for deployment ${deploymentId}: ${getErrorMessage(error)}`,
      );
      catalog = emptyCustomizationCatalog();
    }
    return DeploymentPresenter.toResponse(aggregate, catalog);
  }

  public async getDeploymentAggregate(deploymentId: string): Promise<DeploymentAggregate> {
    const aggregate = await DeploymentRecord.findActiveAggregateById(deploymentId);
    if (!aggregate) {
      throw new NotFoundException('Deployment not found');
    }
    return aggregate;
  }

  public async getDeploymentByDeviceId(deviceId: string): Promise<DeploymentAggregate> {
    const aggregate = await DeploymentRecord.findAggregateByDeviceId(deviceId);
    if (!aggregate) {
      throw new NotFoundException('Deployment not found');
    }
    return aggregate;
  }

  public async getDeploymentsForOrganizations(query: PaginationQuery) {
    const deployments = await DeploymentRecord.findActiveAggregatesForCaller();
    const responses = deployments.map((deployment) => DeploymentPresenter.toResponse(deployment));
    return paginateArray(responses, query, { searchableFields: [] });
  }

  async updateDeploymentNickname(deploymentId: string, body: UpdateDeploymentRecordDTO) {
    this.contextService.requirePermission('deployment', 'update');
    const record = await DeploymentRecord.findActiveById(deploymentId);
    if (!record) {
      throw new NotFoundException('Deployment not found');
    }
    record.rename(body.name);
    await record.save();

    const aggregate = await DeploymentRecord.findActiveAggregateById(deploymentId);
    if (!aggregate) {
      throw new NotFoundException('Deployment not found');
    }
    return DeploymentPresenter.toResponse(aggregate);
  }

  async reprovisionDirectProvisionDeployment(deploymentId: string, data: ReprovisionDeploymentInput) {
    this.contextService.requirePermission('deployment', 'update');
    const aggregate = await DeploymentRecord.findActiveAggregateById(deploymentId);
    if (!aggregate) {
      throw new NotFoundException('Deployment not found');
    }

    if (aggregate.isLocked) {
      throw new BadRequestException('Cannot reprovision deployment: deployment is locked');
    }

    this.provisionValidator.validateDiskLayouts(data.diskLayouts, 'reprovision');
    this.provisionValidator.validateIpxeRequirements(data.operatingSystem, data.ipxeUrl);

    // the deployment lookup above is the authorization boundary; the device belongs to the supplier, not the reader
    const deviceRecord = await BaremetalRecord.findByIdUnscoped(aggregate.server.device.id, { includeDeleted: true });
    if (!deviceRecord) {
      throw new NotFoundException('Device not found for deployment');
    }
    if (deviceRecord.data.deletedAt) {
      throw new BadRequestException('Cannot reprovision a decommissioned (soft-deleted) device');
    }
    this.provisionValidator.validateDiskGroupHomogeneity(data.diskLayouts, deviceRecord.data.storageDrives ?? []);
    this.provisionValidator.validateDiskGroupSizeLimits(data.diskLayouts, deviceRecord.data.storageDrives ?? []);
    const hw = ServerSpecHelper.hardwareSummary(deviceRecord.data);
    const customizations = flattenCustomizations(data.customizations);
    if (isTeeRequested(data.operatingSystem, data.tee, customizations)) {
      assertTeeAllowed(deviceRecord.data);
    }
    const buildId = await resolveZoneBuildId(this.prisma, deviceRecord.data.zoneId, {
      strict: true,
      Exception: BadRequestException,
    });
    await this.provisionValidator.validateCustomizations(
      customizations,
      hw.gpuModel,
      ServerSpecHelper.teeCapable(deviceRecord.data),
      data.operatingSystem,
      normalizeArchForArtifact(hw.architecture),
      buildId,
    );

    const cloudInitContent = await this.cloudInitTemplatesService.resolveAndSave(data);
    const processedCloudInit = this.cloudInitProcessor.process(cloudInitContent);

    return await this.lifecycleService.requestReprovision({
      deviceId: aggregate.server.device.id,
      userId: this.contextService.userId,
      organizationId: this.contextService.organizationId,
      deploymentName: data.deploymentName,
      operatingSystemSlug: data.operatingSystem,
      sshKeyIds: data.sshKeyIds,
      diskLayouts: data.diskLayouts,
      cloudInit: processedCloudInit,
      ipxeUrl: data.ipxeUrl ?? null,
      customizations,
      tee: data.tee ?? false,
      source: this.contextService.requestSource,
    });
  }

  async rebootDirectProvisionDevice(deploymentId: string) {
    this.contextService.requirePermission('device', 'power-control');
    const aggregate = await DeploymentRecord.findActiveAggregateById(deploymentId);
    if (!aggregate) {
      throw new NotFoundException('Deployment not found');
    }

    if (aggregate.isLocked) {
      throw new BadRequestException('Cannot issue reboot commands: deployment is locked');
    }

    if (TRANSITIONAL_POWER_STATUSES.includes(serverPowerStatusToLegacy(aggregate.server.powerStatus) ?? '')) {
      throw new BadRequestException('Cannot issue reboot commands: a power state transition is already in progress');
    }

    return await this.lifecycleService.requestReboot({
      deviceId: aggregate.server.device.id,
      deploymentId,
      userId: this.contextService.userId,
      organizationId: this.contextService.organizationId,
      source: this.contextService.requestSource,
    });
  }

  async powerControlDevice(
    deploymentId: string,
    data: Omit<
      PowerControlDeploymentJob,
      'source' | 'userId' | 'organizationId' | 'deviceId' | 'deviceMetadataId' | 'jobId'
    >,
  ) {
    this.contextService.requirePermission('device', 'power-control');
    const aggregate = await DeploymentRecord.findActiveAggregateById(deploymentId);
    if (!aggregate) {
      throw new NotFoundException('Deployment not found');
    }

    if (aggregate.isLocked) {
      throw new BadRequestException('Cannot issue power commands: deployment is locked');
    }

    if (TRANSITIONAL_POWER_STATUSES.includes(serverPowerStatusToLegacy(aggregate.server.powerStatus) ?? '')) {
      throw new BadRequestException('Cannot issue power commands: a power state transition is already in progress');
    }

    return await this.lifecycleService.requestPowerControl({
      operation: data.operation,
      deviceId: aggregate.server.device.id,
      deploymentId,
      userId: this.contextService.userId,
      organizationId: this.contextService.organizationId,
      source: this.contextService.requestSource,
    });
  }

  async deprovisionDirectProvisionDevice(deploymentId: string) {
    this.contextService.requirePermission('deployment', 'delete');
    const aggregate = await DeploymentRecord.findActiveAggregateById(deploymentId);
    if (!aggregate) {
      throw new NotFoundException('Deployment not found');
    }

    if (aggregate.isLocked) {
      throw new BadRequestException('Cannot deprovision deployment: deployment is locked');
    }

    return await this.lifecycleService.requestDeprovision({
      deviceId: aggregate.server.device.id,
      userId: this.contextService.userId,
      organizationId: this.contextService.organizationId,
      source: this.contextService.requestSource,
    });
  }

  async getLogsForDeploymentJob({ deploymentId, jobType }: { deploymentId: string; jobType: ExportLogsJobType }) {
    const aggregate = await DeploymentRecord.findActiveAggregateById(deploymentId);
    if (!aggregate) {
      throw new NotFoundException('Deployment not found');
    }

    // the deployment lookup is the authorization boundary; the job's tenant is whoever requested it, not the reader
    const latestJob: LifecycleJobRecord | null = await LifecycleJobRecord.findOneUnscoped({
      where: { deploymentId: aggregate.id, jobType },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestJob) {
      throw new NotFoundException('No jobs found for deployment');
    }

    const { zoneId } = await this.deviceContextService.resolveZoneContext(aggregate.server.device.id);
    const { entries, complete } = await this.solLogService.getLogsForPlan(zoneId, latestJob.data.id);

    return {
      success: true,
      message: complete ? 'SOL log streaming complete' : 'SOL log streaming in progress',
      entries,
      complete,
    };
  }

  async activateRescueMode(deploymentId: string): Promise<string> {
    this.contextService.requirePermission('deployment', 'update');
    const aggregate = await DeploymentRecord.findActiveAggregateById(deploymentId);
    if (!aggregate) {
      throw new NotFoundException('Deployment not found');
    }
    const record = await DeploymentRecord.findActiveById(deploymentId);
    if (!record) {
      throw new NotFoundException('Deployment not found');
    }
    return this.rescueModeService.activate({
      deviceId: aggregate.server.device.id,
      aggregate,
      record,
      rescueOsSlug: RESCUE_OS_SLUG,
      opLabel: 'rescue activate',
    });
  }

  async deactivateRescueMode(deploymentId: string): Promise<string> {
    this.contextService.requirePermission('deployment', 'update');
    const aggregate = await DeploymentRecord.findActiveAggregateById(deploymentId);
    if (!aggregate) {
      throw new NotFoundException('Deployment not found');
    }
    const record = await DeploymentRecord.findActiveById(deploymentId);
    if (!record) {
      throw new NotFoundException('Deployment not found');
    }
    return this.rescueModeService.deactivate({
      deviceId: aggregate.server.device.id,
      aggregate,
      record,
      opLabel: 'rescue deactivate',
    });
  }

  async toggleDeploymentLock(deploymentId: string) {
    this.contextService.requirePermission('deployment', 'update');
    const record = await DeploymentRecord.findActiveById(deploymentId);
    if (!record) {
      throw new NotFoundException('Deployment not found');
    }

    record.toggleLock();
    await record.save();
    return record.data.isLocked;
  }

  async tryTriggerDeploymentEvent(eventType: WebhookEventType, aggregate: DeploymentAggregate): Promise<void> {
    try {
      await this.triggerDeploymentEvent(eventType, aggregate);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.error(
        `Failed to trigger webhook for device deployment update: ${errorMessage}`,
        ensureError(error).stack,
      );
    }
  }

  async triggerDeploymentEvent(eventType: WebhookEventType, aggregate: DeploymentAggregate): Promise<void> {
    const organizationId = aggregate.customerId;

    const webhooks = await this.webhookRepo.findMany({
      isActive: true,
      events: { has: eventType },
      organizationId,
    });

    this.logger.log(`Triggering ${eventType} event for ${webhooks.length} webhooks in organization ${organizationId}`);

    const eventDto: WebhookEventDTO = {
      eventType,
      data: DeploymentPresenter.toResponse(aggregate),
      timestamp: new Date(),
    };

    const deliveryPromises = webhooks.map((webhook) =>
      this.webhookDeliveryService.scheduleDelivery(webhook, eventDto).catch((error) => {
        this.logger.error(`Failed to schedule delivery for webhook ${webhook.id}:`, error);
      }),
    );

    await Promise.all(deliveryPromises);
  }

  private async resolveTargetProjectId(data: CreateDeploymentData): Promise<string> {
    if (data.projectId) {
      const owned = await DeploymentProjectRecord.findActiveByIdUnscoped(data.projectId, data.customerId);
      if (!owned) {
        throw new NotFoundException(`Project ${data.projectId} not found`);
      }
      return data.projectId;
    }

    const defaultProject = await DeploymentProjectRecord.findActiveDefaultUnscoped(data.customerId);

    if (defaultProject) {
      return defaultProject.id;
    }

    try {
      const newProject = await DeploymentProjectRecord.createWithRelations({
        name: 'Default Project',
        isDefault: true,
        organizationId: data.customerId,
      });
      return newProject.id;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await DeploymentProjectRecord.findActiveDefaultUnscoped(data.customerId);
        if (winner) {
          return winner.id;
        }
      }
      throw error;
    }
  }

  async getInterruptibleClaims(status: InterruptibleClaimStatus | undefined, query: PaginationQuery) {
    const organizationId = this.contextService.organizationId;
    const claims = await this.prisma.interruptibleClaim.findMany({
      where: {
        organizationId,
        ...(status && { status }),
      },
      include: { server: { select: { deviceId: true } } },
      orderBy: { createdAt: 'desc' },
    });

    const responses = claims.map((claim) => ({
      id: claim.id,
      deploymentName: claim.deploymentName,
      status: claim.status,
      interruptAt: claim.interruptAt.toISOString(),
      deviceId: claim.server.deviceId,
    }));
    return paginateArray(responses, query, { searchableFields: [] });
  }
}
