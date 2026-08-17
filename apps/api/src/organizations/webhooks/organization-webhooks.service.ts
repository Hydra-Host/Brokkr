import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { WebhookDelivery } from '@repo/database';
import { paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { ContextService } from 'src/common/context/context.service';
import { WebhookDeliveryService } from 'src/webhook/webhook-delivery.service';
import { WebhookService } from 'src/webhook/webhook.service';
import { CreateWebhookDTO, UpdateWebhookDTO, isPublicHttpsUrl } from 'src/webhook/webhook.types';

@Injectable()
export class OrganizationWebhooksService {
  constructor(
    private readonly contextService: ContextService,
    private readonly webhookService: WebhookService,
    private readonly webhookDeliveryService: WebhookDeliveryService,
  ) {}

  async createWebhook(createWebhookDto: CreateWebhookDTO) {
    this.contextService.requirePermission('webhook', 'create');

    if (!isPublicHttpsUrl(createWebhookDto.endpoint)) {
      throw new HttpException(
        'Endpoint must be a public HTTPS URL — private IPs, localhost, and non-HTTPS schemes are not allowed',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const organizationId = this.contextService.organizationId;
    const webhook = await this.webhookService.create(organizationId, createWebhookDto);

    return {
      id: webhook.id,
      endpoint: webhook.endpoint,
      description: webhook.description,
      events: webhook.events,
      isActive: webhook.isActive,
      createdAt: webhook.createdAt,
      secret: webhook.secret,
    };
  }

  async getWebhooks(query: PaginationQuery) {
    this.contextService.requirePermission('webhook', 'read');
    const organizationId = this.contextService.organizationId;
    const webhooks = await this.webhookService.findAllByOrganization(organizationId);

    const responses = webhooks.map((webhook) => ({
      id: webhook.id,
      endpoint: webhook.endpoint,
      description: webhook.description,
      events: webhook.events,
      isActive: webhook.isActive,
      createdAt: webhook.createdAt,
      updatedAt: webhook.updatedAt,
    }));
    return paginateArray(responses, query, { searchableFields: [] });
  }

  private toDeliveryResponse(delivery: WebhookDelivery, webhookEndpoint: string) {
    return {
      id: delivery.id,
      webhookId: delivery.webhookId,
      webhookEndpoint,
      eventType: delivery.eventType,
      payload: delivery.payload,
      status: delivery.status,
      statusCode: delivery.httpStatus,
      responseBody: delivery.responseBody,
      attemptNumber: delivery.attempts,
      error: delivery.errorMessage,
      createdAt: delivery.createdAt,
      deliveredAt: delivery.deliveredAt,
    };
  }

  async getWebhookDeliveries(query: PaginationQuery) {
    this.contextService.requirePermission('webhook', 'read');
    const organizationId = this.contextService.organizationId;
    const deliveries = await this.webhookDeliveryService.getDeliveries(organizationId);

    const responses = deliveries.map((delivery) =>
      this.toDeliveryResponse(delivery, delivery.webhook?.endpoint || 'Unknown'),
    );
    return paginateArray(responses, query, { searchableFields: [] });
  }

  async getWebhook(webhookId: string) {
    this.contextService.requirePermission('webhook', 'read');
    const organizationId = this.contextService.organizationId;
    const webhook = await this.webhookService.findOne(webhookId);

    if (webhook.organizationId !== organizationId) {
      throw new ForbiddenException('Webhook not found');
    }

    return {
      id: webhook.id,
      endpoint: webhook.endpoint,
      description: webhook.description,
      events: webhook.events,
      isActive: webhook.isActive,
      createdAt: webhook.createdAt,
      updatedAt: webhook.updatedAt,
    };
  }

  async updateWebhook(webhookId: string, updateWebhookDto: UpdateWebhookDTO) {
    this.contextService.requirePermission('webhook', 'update');

    if (!isPublicHttpsUrl(updateWebhookDto.endpoint)) {
      throw new HttpException(
        'Endpoint must be a public HTTPS URL — private IPs, localhost, and non-HTTPS schemes are not allowed',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const organizationId = this.contextService.organizationId;
    const existingWebhook = await this.webhookService.findOne(webhookId);

    if (existingWebhook.organizationId !== organizationId) {
      throw new ForbiddenException('Webhook not found');
    }

    const isBeingReactivated = !existingWebhook.isActive && updateWebhookDto.isActive;
    const webhook = await this.webhookService.update(webhookId, updateWebhookDto, isBeingReactivated);

    return {
      id: webhook.id,
      endpoint: webhook.endpoint,
      description: webhook.description,
      events: webhook.events,
      isActive: webhook.isActive,
      createdAt: webhook.createdAt,
      updatedAt: webhook.updatedAt,
    };
  }

  async deleteWebhook(webhookId: string) {
    this.contextService.requirePermission('webhook', 'delete');

    const organizationId = this.contextService.organizationId;
    const webhook = await this.webhookService.findOne(webhookId);

    if (webhook.organizationId !== organizationId) {
      throw new ForbiddenException('Webhook not found');
    }

    return this.webhookService.remove(webhookId);
  }

  async retryDelivery(deliveryId: string) {
    this.contextService.requirePermission('webhook', 'update');

    const organizationId = this.contextService.organizationId;
    const delivery = await this.webhookDeliveryService.getDeliveryDetails(deliveryId);
    const webhook = await this.webhookService.findOne(delivery.webhookId);

    if (webhook.organizationId !== organizationId) {
      throw new ForbiddenException('Delivery not found');
    }

    const retried = await this.webhookDeliveryService.retryDelivery(deliveryId);
    return this.toDeliveryResponse(retried, webhook.endpoint);
  }

  async getWebhookStats() {
    this.contextService.requirePermission('webhook', 'read');
    const organizationId = this.contextService.organizationId;
    return this.webhookService.getWebhookStats(organizationId);
  }
}
