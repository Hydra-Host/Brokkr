import { Injectable, NotFoundException } from '@nestjs/common';
import { CreateWebhookDTO, UpdateWebhookDTO, WebhookConfig, WebhookStats } from './webhook.types';

import { Webhook } from '@repo/database';
import * as crypto from 'crypto';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { WebhookRepository } from './webhook.repository';

@Injectable()
export class WebhookService {
  constructor(
    private readonly repo: WebhookRepository,
    private readonly webhookDeliveryRepo: WebhookDeliveryRepository,
    @Logger(WebhookService.name) private readonly logger: LoggerService,
  ) {}

  async create(organizationId: string, createWebhookDto: CreateWebhookDTO): Promise<Webhook> {
    const secret = this.generateSecret();

    return this.repo.create(organizationId, {
      ...createWebhookDto,
      secret,
    });
  }

  async update(id: string, updateWebhookDto: UpdateWebhookDTO, resetFailureCount = false): Promise<Webhook> {
    const existing = await this.repo.findFirst({ id, deletedAt: null });
    if (!existing) {
      throw new NotFoundException('Webhook not found');
    }

    const updateData: any = { ...updateWebhookDto };

    if (resetFailureCount) {
      updateData.failureCount = 0;
      updateData.lastFailureAt = null;
    }

    return this.repo.update(id, updateData);
  }

  async remove(id: string): Promise<void> {
    const existing = await this.repo.findFirst({ id, deletedAt: null });
    if (!existing) {
      throw new NotFoundException('Webhook not found');
    }
    await this.repo.update(id, { deletedAt: new Date() });
  }

  async findAllByOrganization(organizationId: string): Promise<Webhook[]> {
    return this.repo.findMany({
      organizationId,
      deletedAt: null,
    });
  }

  async findOne(id: string): Promise<Webhook> {
    const webhook = await this.repo.findFirst({
      id,
      deletedAt: null,
    });

    if (!webhook) {
      throw new NotFoundException('Webhook not found');
    }

    return webhook;
  }

  async regenerateSecret(id: string): Promise<{ secret: string }> {
    const existing = await this.repo.findFirst({ id, deletedAt: null });
    if (!existing) {
      throw new NotFoundException('Webhook not found');
    }

    const secret = this.generateSecret();
    await this.repo.update(id, { secret });
    return { secret };
  }

  async incrementFailureCount(webhookId: string): Promise<void> {
    const webhook = await this.repo.update(webhookId, {
      failureCount: { increment: 1 },
      lastFailureAt: new Date(),
    });

    if (webhook.failureCount >= WebhookConfig.MAX_FAILURES_BEFORE_DISABLE) {
      await this.repo.update(webhookId, { isActive: false });

      this.logger.warn(`Webhook ${webhookId} disabled after ${webhook.failureCount} failures`);

      await this.webhookDeliveryRepo.updateManyPendingOrRetryingToFailed(
        webhookId,
        'Webhook was deactivated due to repeated failures',
      );

      this.logger.log(`Marked pending/retrying deliveries as failed for deactivated webhook ${webhookId}`);
    }
  }

  async resetFailureCount(webhookId: string): Promise<void> {
    await this.repo.update(webhookId, {
      failureCount: 0,
      lastFailureAt: null,
    });
  }

  async getWebhookStats(organizationId: string): Promise<WebhookStats> {
    const stats = await this.repo.getWebhookStats(organizationId);
    return {
      total: stats.total,
      active: stats.active,
      failed: stats.failed,
      // Internal queue/worker fields (idempotency key, processing-lock) must not reach the API response.
      recentDeliveries: stats.recentDeliveries.map((delivery) => ({
        id: delivery.id,
        webhookId: delivery.webhookId,
        eventType: delivery.eventType,
        payload: delivery.payload,
        status: delivery.status,
        httpStatus: delivery.httpStatus,
        responseBody: delivery.responseBody,
        errorMessage: delivery.errorMessage,
        attempts: delivery.attempts,
        nextRetryAt: delivery.nextRetryAt,
        createdAt: delivery.createdAt,
        deliveredAt: delivery.deliveredAt,
        webhook: delivery.webhook,
      })),
    };
  }

  private generateSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}
