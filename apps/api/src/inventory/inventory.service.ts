import { InventoryVisibilityFilterRegistry } from '@hydrahost/plugin-sdk';
import { BadRequestException, ConflictException, HttpException, Injectable, NotFoundException } from '@nestjs/common';
import {
  type DeviceCategory,
  type DeviceStockStatus,
  type InventoryListing,
  type ProvisionRequest,
  type Region,
} from '@repo/api-client';
import { WebhookEventType } from '@repo/database';
import { paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { ServerSpecHelper } from '@repo/device-domain';
import {
  buildCustomizationCatalog,
  emptyCustomizationCatalog,
  LayerRecord,
  resolveZoneBuildId,
  type CustomizationCatalog,
} from '@repo/layers';
import { normalizeArchForArtifact, provisionContractTypeWriteRejection } from '@repo/utils';
import { CloudInitTemplatesService } from 'src/cloud-init-templates/cloud-init-templates.service';
import { ContextService } from 'src/common/context/context.service';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LifecycleService } from 'src/lifecycle/lifecycle.service';
import type { ProvisionRequest as EngineProvisionRequest } from 'src/lifecycle/operations/provision.operation';
import { LoggerService } from 'src/logger/logger.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { assertTeeAllowed, isTeeRequested } from 'src/provision/assert-tee-allowed';
import { CloudInitProcessor, flattenCustomizations, ProvisionValidatorService } from 'src/provision/processors';
import { WebhookDeliveryService } from 'src/webhook/webhook-delivery.service';
import { WebhookRepository } from 'src/webhook/webhook.repository';
import { WebhookEventDTO } from 'src/webhook/webhook.types';
import { InventoryListingContext, InventoryPresenter } from './inventory.presenter';
import { InventoryAggregate, InventoryRecord } from './inventory.record';

@Injectable()
export class InventoryService {
  constructor(
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly webhookRepo: WebhookRepository,
    private readonly lifecycleService: LifecycleService,
    private readonly contextService: ContextService,
    private readonly prisma: PrismaClient,
    private readonly cloudInitProcessor: CloudInitProcessor,
    private readonly provisionValidator: ProvisionValidatorService,
    private readonly cloudInitTemplatesService: CloudInitTemplatesService,
    @Logger(InventoryService.name) private readonly logger: LoggerService,
  ) {}

  async getListings(filters?: string, page = 1, pageSize = 12) {
    const { category, status, interruptibleReady } = this.parseInventoryFilters(filters);
    const devices = await InventoryRecord.findListings(
      category,
      interruptibleReady,
      await this.excludedListedSupplierIds(),
    );

    const listCatalog: CustomizationCatalog = { bases: await this.loadBaseLayers(), componentsByBase: {} };
    let contexts = devices.map((device) => this.buildContext(device, listCatalog));

    if (status) {
      contexts = this.filterListingsByStatus(contexts, status);
    }

    const allListings = this.removeIncorrectGpuListings(
      category,
      contexts.map((ctx) => InventoryPresenter.toResponse(ctx, this.contextService.identity)),
    );

    return paginateArray(allListings, { page, pageSize }, { searchableFields: [] });
  }

  async getListingById(deviceId: string): Promise<InventoryListing> {
    const ctx = await this.getListingContext(deviceId);
    return InventoryPresenter.toResponse(ctx, this.contextService.identity);
  }

  private async getListingContext(deviceId: string, withCatalog = true): Promise<InventoryListingContext> {
    const identity = this.contextService.requireIdentity;
    const aggregate = await InventoryRecord.findListableById(deviceId);
    if (!aggregate) {
      throw new NotFoundException('Listing not found');
    }

    const ctx = this.buildContext(aggregate);

    if (!InventoryPresenter.isListable(ctx)) {
      this.logger.warn(`Listing ${deviceId} is not listable`);
      throw new NotFoundException('Listing not found');
    }

    const catalogVisible =
      !aggregate.supplierId ||
      (await InventoryVisibilityFilterRegistry.excludedSupplierIds([aggregate.supplierId])).length === 0;
    if (!InventoryPresenter.isListedOrInvitee(ctx, identity, catalogVisible)) {
      this.logger.warn(`Listing ${deviceId} is not listed-or-invitee for organization ${identity.organizationId}`);
      throw new NotFoundException('Listing not found');
    }

    if (withCatalog) {
      ctx.catalog = await this.buildCatalog(aggregate);
    }

    return ctx;
  }

  async provisionDirectProvisionDevice(data: ProvisionRequest & { deviceId: string }): Promise<{
    jobId: string | null;
  }> {
    this.contextService.requirePermission('inventory', 'create');
    const identity = this.contextService.requireIdentity;
    const listing = await this.getListingContext(data.deviceId, false);

    this.provisionValidator.validate(data, listing.device.storageDrives ?? []);

    const customizations = flattenCustomizations(data.customizations);
    const hw = ServerSpecHelper.hardwareSummary(listing.device);
    const teeCapable = ServerSpecHelper.teeCapable(listing.device);
    if (isTeeRequested(data.operatingSystem, data.tee, customizations)) {
      assertTeeAllowed(listing.device);
    }
    const buildId = await resolveZoneBuildId(this.prisma, listing.device.zoneId, {
      strict: true,
      Exception: BadRequestException,
    });
    await this.provisionValidator.validateCustomizations(
      customizations,
      hw.gpuModel,
      teeCapable,
      data.operatingSystem,
      normalizeArchForArtifact(hw.architecture),
      buildId,
    );

    const cloudInitContent = await this.cloudInitTemplatesService.resolveAndSave(data);
    const processedCloudInit = this.cloudInitProcessor.process(cloudInitContent);

    const contractTypeRejection = provisionContractTypeWriteRejection({
      contractType: data.contractType,
      isInterruptible: data.isInterruptible,
    });
    if (contractTypeRejection) {
      throw new BadRequestException(contractTypeRejection);
    }
    const isInterruptible = false;

    const request: EngineProvisionRequest = {
      deviceId: listing.device.id,
      userId: this.contextService.userId,
      organizationId: identity.organizationId,
      deploymentName: data.deploymentName,
      operatingSystemSlug: data.operatingSystem,
      sshKeyIds: data.sshKeyIds,
      diskLayouts: data.diskLayouts,
      projectId: data.projectId,
      cloudInit: processedCloudInit,
      ipxeUrl: data.ipxeUrl ?? null,
      customizations,
      tee: data.tee ?? false,
      passwordHash: null,
      source: this.contextService.requestSource,
      internalProvision: false,
      isInterruptible,
    };

    const occupying = InventoryPresenter.activeDeployment(listing);
    const isTakeover = !!occupying && occupying.isInterruptible && occupying.customerId !== identity.organizationId;

    if (isTakeover) {
      throw new BadRequestException(
        'This host is occupied by an interruptible deployment; interruptible takeovers are unavailable until commerce billing is ready',
      );
    }

    const job = await this.lifecycleService.requestProvision(request);
    return { jobId: job.data.id };
  }

  async getRegions(query: PaginationQuery) {
    const regions = await this.prisma.region.findMany({
      orderBy: { name: 'asc' },
      select: { name: true },
    });

    const allRegions: Region[] = regions.map((region) => ({ name: region.name }));
    return paginateArray(allRegions, query, { searchableFields: [], defaultPageSize: 100 });
  }

  async getCategoryPrices(query: PaginationQuery) {
    const prices = await InventoryRecord.getAllCategoryPrices(await this.excludedListedSupplierIds());
    return paginateArray(prices, query, { searchableFields: [], defaultPageSize: 100 });
  }

  async getCategoryAvailability(query: PaginationQuery) {
    const availability = await InventoryRecord.getCategoryAvailability(await this.excludedListedSupplierIds());
    return paginateArray(availability, query, { searchableFields: [], defaultPageSize: 100 });
  }

  private async excludedListedSupplierIds(): Promise<string[]> {
    if (!InventoryVisibilityFilterRegistry.hasFilters()) return [];
    return InventoryVisibilityFilterRegistry.excludedSupplierIds(await InventoryRecord.listedSupplierIds());
  }

  private removeIncorrectGpuListings(category: DeviceCategory, listings: InventoryListing[]) {
    switch (category) {
      case 'a10':
        return listings.filter((listing) => !listing.specs.gpu.model?.toLowerCase().includes('a100'));
      case 'h200':
        return listings.filter((listing) => !listing.specs.gpu.model?.toLowerCase().includes('gh200'));
      case 'b200':
        return listings.filter((listing) => !listing.specs.gpu.model?.toLowerCase().includes('gb200'));
      case 'b300':
        return listings.filter((listing) => !listing.specs.gpu.model?.toLowerCase().includes('gb300'));
      case 'gb200':
        return listings.filter(
          (listing) =>
            !listing.specs.gpu.model?.toLowerCase().includes('b200') ||
            listing.specs.gpu.model?.toLowerCase().includes('gb200'),
        );
      case 'gb300':
        return listings.filter(
          (listing) =>
            !listing.specs.gpu.model?.toLowerCase().includes('b300') ||
            listing.specs.gpu.model?.toLowerCase().includes('gb300'),
        );
      default:
        return listings;
    }
  }

  private parseInventoryFilters(filters?: string): {
    category?: DeviceCategory;
    status?: DeviceStockStatus;
    interruptibleReady?: boolean;
  } {
    if (!filters) return {};

    const result: { category?: DeviceCategory; status?: DeviceStockStatus; interruptibleReady?: boolean } = {};

    for (const tuple of filters.split('|')) {
      const parts = tuple.split(':');
      if (parts.length < 3) continue;
      const [field, operator, ...rest] = parts;
      if (operator !== 'eq') continue;
      const value = rest.join(':');

      switch (field) {
        case 'category':
          result.category = value as DeviceCategory;
          break;
        case 'status':
          result.status = value as DeviceStockStatus;
          break;
        case 'interruptibleReady':
          result.interruptibleReady = value === 'true';
          break;
      }
    }

    return result;
  }

  private buildContext(aggregate: InventoryAggregate, catalog?: CustomizationCatalog): InventoryListingContext {
    const server = aggregate.server;
    return {
      device: aggregate,
      reservationInvites: (server?.serversInReservationInvite ?? []).map((dir) => dir.reservationInvite),
      deployments: server?.deployments ?? [],
      catalog,
    };
  }

  private async loadBaseLayers(): Promise<CustomizationCatalog['bases']> {
    try {
      return await LayerRecord.findBaseLayerSummaries();
    } catch (error) {
      this.logger.error(`Failed to load base layers for inventory listings: ${getErrorMessage(error)}`);
      return [];
    }
  }

  private async buildCatalog(aggregate: InventoryAggregate): Promise<CustomizationCatalog> {
    const hw = ServerSpecHelper.hardwareSummary(aggregate);
    try {
      const buildId = await resolveZoneBuildId(this.prisma, aggregate.zoneId, { Exception: ConflictException });
      return await buildCustomizationCatalog(hw.gpuModel, ServerSpecHelper.teeCapable(aggregate), hw.architecture, {
        onComponentError: (error) =>
          this.logger.error(
            `Failed to hydrate customization components for listing ${aggregate.id}: ${getErrorMessage(error)}`,
          ),
        buildId: buildId ?? undefined,
      });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(
        `Failed to hydrate customization catalog for listing ${aggregate.id}: ${getErrorMessage(error)}`,
      );
      return emptyCustomizationCatalog();
    }
  }

  private filterListingsByStatus(contexts: InventoryListingContext[], status: DeviceStockStatus) {
    const normalizedStatus = status.replace(/on\+demand/g, 'on demand');
    return contexts.filter((ctx) => normalizedStatus.includes(InventoryPresenter.stockStatus(ctx)));
  }

  async tryTriggerListingEvent(eventType: WebhookEventType, deviceId: string): Promise<void> {
    try {
      await this.triggerListingEvent(eventType, deviceId);
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      this.logger.error(
        `Failed to trigger webhook for device listing update: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async triggerListingEvent(eventType: WebhookEventType, deviceId: string): Promise<void> {
    const webhooks = await this.webhookRepo.findMany({
      isActive: true,
      events: { has: eventType },
    });

    this.logger.log(`Triggering ${eventType} event for ${webhooks.length} webhooks`);

    const aggregate = await InventoryRecord.findById(deviceId);
    if (!aggregate) {
      throw new NotFoundException('Listing not found');
    }

    const listCatalog: CustomizationCatalog = { bases: await this.loadBaseLayers(), componentsByBase: {} };
    const ctx = this.buildContext(aggregate, listCatalog);

    const eventDto: WebhookEventDTO = {
      eventType,
      // No identity: system-context delivery keeps activeReservationInvite null — emitting it would leak another tenant's org and emails to subscribers.
      data: InventoryPresenter.toResponse(ctx),
      timestamp: new Date(),
    };

    const deliveryPromises = webhooks.map((webhook) =>
      this.webhookDeliveryService.scheduleDelivery(webhook, eventDto).catch((error) => {
        this.logger.error(`Failed to schedule delivery for webhook ${webhook.id}:`, error);
      }),
    );

    await Promise.all(deliveryPromises);
  }
}
