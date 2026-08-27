import { Controller } from '@nestjs/common';
import { contract } from '@repo/api-client';
import { TsRestHandler, tsRestHandler } from '@ts-rest/nest';
import { AuditAction } from 'src/event-log/audit-action.decorator';
import { OrganizationWebhooksService } from './organization-webhooks.service';

@Controller()
export class OrganizationWebhooksController {
  constructor(private readonly organizationWebhooksService: OrganizationWebhooksService) {}

  @AuditAction({ actionKey: 'webhook.created', resource: 'webhook', action: 'create' })
  @TsRestHandler(contract.createWebhook)
  async createWebhook() {
    return tsRestHandler(contract.createWebhook, async ({ body }) => {
      const webhook = await this.organizationWebhooksService.createWebhook(body);

      return {
        status: 201 as const,
        body: webhook,
      };
    });
  }

  @TsRestHandler(contract.listWebhooks)
  async listWebhooks() {
    return tsRestHandler(contract.listWebhooks, async ({ query }) => {
      const paginated = await this.organizationWebhooksService.getWebhooks(query);

      return {
        status: 200 as const,
        body: paginated,
      };
    });
  }

  @TsRestHandler(contract.getWebhookDeliveries)
  async getWebhookDeliveries() {
    return tsRestHandler(contract.getWebhookDeliveries, async ({ query }) => {
      const paginated = await this.organizationWebhooksService.getWebhookDeliveries(query);

      return {
        status: 200 as const,
        body: paginated,
      };
    });
  }

  @TsRestHandler(contract.getWebhookStats)
  async getWebhookStats() {
    return tsRestHandler(contract.getWebhookStats, async () => {
      const stats = await this.organizationWebhooksService.getWebhookStats();

      return {
        status: 200 as const,
        body: stats,
      };
    });
  }

  @TsRestHandler(contract.getWebhook)
  async getWebhook() {
    return tsRestHandler(contract.getWebhook, async ({ params }) => {
      const webhook = await this.organizationWebhooksService.getWebhook(params.webhookId);

      return {
        status: 200 as const,
        body: webhook,
      };
    });
  }

  @AuditAction({ actionKey: 'webhook.updated', resource: 'webhook', action: 'update' })
  @TsRestHandler(contract.updateWebhook)
  async updateWebhook() {
    return tsRestHandler(contract.updateWebhook, async ({ params, body }) => {
      const webhook = await this.organizationWebhooksService.updateWebhook(params.webhookId, body);

      return {
        status: 200 as const,
        body: webhook,
      };
    });
  }

  @AuditAction({ actionKey: 'webhook.deleted', resource: 'webhook', action: 'delete' })
  @TsRestHandler(contract.deleteWebhook)
  async deleteWebhook() {
    return tsRestHandler(contract.deleteWebhook, async ({ params }) => {
      await this.organizationWebhooksService.deleteWebhook(params.webhookId);

      return {
        status: 204 as const,
        body: undefined,
      };
    });
  }

  @TsRestHandler(contract.retryWebhookDelivery)
  async retryWebhookDelivery() {
    return tsRestHandler(contract.retryWebhookDelivery, async ({ params }) => {
      const delivery = await this.organizationWebhooksService.retryDelivery(params.deliveryId);

      return {
        status: 200 as const,
        body: delivery,
      };
    });
  }
}
