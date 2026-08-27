import { ForbiddenException, HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma, WebhookDelivery } from '@repo/database';
import { paginateArray, type PaginationQuery } from '@repo/database/pagination';
import { ContextService, type PermissionIntentHandle } from 'src/common/context/context.service';
import { EventLogService } from 'src/event-log/event-log.service';
import { PrismaClient } from 'src/prisma/prisma.client';
import { WebhookDeliveryService } from 'src/webhook/webhook-delivery.service';
import { WebhookService } from 'src/webhook/webhook.service';
import { CreateWebhookDTO, UpdateWebhookDTO, isPublicHttpsUrl } from 'src/webhook/webhook.types';

interface WebhookEvent {
  action: string;
  actionKey: string;
  targetId: string;
  targetLabel: string;
}

@Injectable()
export class OrganizationWebhooksService {
  constructor(
    private readonly contextService: ContextService,
    private readonly webhookService: WebhookService,
    private readonly webhookDeliveryService: WebhookDeliveryService,
    private readonly eventLog: EventLogService,
    private readonly prisma: PrismaClient,
  ) {}

  async createWebhook(createWebhookDto: CreateWebhookDTO) {
    const handle = this.contextService.requirePermission('webhook', 'create');

    if (!isPublicHttpsUrl(createWebhookDto.endpoint)) {
      throw new HttpException(
        'Endpoint must be a public HTTPS URL — private IPs, localhost, and non-HTTPS schemes are not allowed',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const organizationId = this.contextService.organizationId;
    const webhook = await this.prisma.$transaction(async (tx) => {
      const created = await this.webhookService.create(organizationId, createWebhookDto, tx);
      await this.emitFor(
        { action: 'created', actionKey: 'webhook.created', targetId: created.id, targetLabel: created.endpoint },
        tx,
      );
      return created;
    });
    this.supersede(handle);

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
    const handle = this.contextService.requirePermission('webhook', 'update');

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
    const webhook = await this.prisma.$transaction(async (tx) => {
      const updated = await this.webhookService.update(webhookId, updateWebhookDto, isBeingReactivated, tx);
      await this.emitFor(
        { action: 'updated', actionKey: 'webhook.updated', targetId: webhookId, targetLabel: updated.endpoint },
        tx,
      );
      return updated;
    });
    this.supersede(handle);

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
    const handle = this.contextService.requirePermission('webhook', 'delete');

    const organizationId = this.contextService.organizationId;
    const webhook = await this.webhookService.findOne(webhookId);

    if (webhook.organizationId !== organizationId) {
      throw new ForbiddenException('Webhook not found');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.webhookService.remove(webhookId, tx);
      await this.emitFor(
        { action: 'deleted', actionKey: 'webhook.deleted', targetId: webhookId, targetLabel: webhook.endpoint },
        tx,
      );
    });
    this.supersede(handle);
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

  /** Shares the mutation's transaction: a webhook is a data-egress path, so a failed insert must roll it back. */
  private emitFor(event: WebhookEvent, tx: Prisma.TransactionClient): Promise<void> {
    return this.eventLog.recordInTransaction(tx, {
      organizationId: this.contextService.organizationId,
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      resource: 'webhook',
      action: event.action,
      actionKey: event.actionKey,
      ...this.contextService.actorFields(),
      ...this.contextService.requestFields(),
      targetId: event.targetId,
      targetLabel: event.targetLabel,
      outcome: 'SUCCEEDED',
      requestId: this.contextService.requestId ?? null,
    });
  }

  /** Called after the transaction resolves: a rollback leaves the handle pending so tier 2 records the failure. */
  private supersede(handle: PermissionIntentHandle | undefined): void {
    if (handle) this.contextService.finalizeIntents([handle]);
  }
}
