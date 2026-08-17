import { HttpService } from '@nestjs/axios';
import { BadRequestException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DeliveryStatus, Webhook, WebhookDelivery } from '@repo/database';
import { truncateString } from '@repo/utils';
import { AxiosError } from 'axios';
import * as crypto from 'crypto';
import { firstValueFrom } from 'rxjs';
import { Logger } from 'src/common/decorators/logger.decorator';
import { getErrorMessage } from 'src/common/error-utils';
import { LoggerService } from 'src/logger/logger.service';
import { WebhookDeliveryRepository } from './webhook-delivery.repository';
import { WebhookRepository } from './webhook.repository';
import { WebhookService } from './webhook.service';
import {
  PinnedIpHttpsAgent,
  SsrfBlockedError,
  WebhookConfig,
  WebhookEventDTO,
  WebhookHeaders,
  assertSafeDeliveryUrl,
} from './webhook.types';

@Injectable()
export class WebhookDeliveryService {
  private readonly instanceId = `instance-${process.pid}-${Date.now()}`;
  private readonly disableRetryCron: boolean;
  private readonly disableCleanupCron: boolean;

  constructor(
    private readonly httpService: HttpService,
    @Inject(forwardRef(() => WebhookService))
    private webhookService: WebhookService,
    private readonly repo: WebhookDeliveryRepository,
    private readonly webhookRepository: WebhookRepository,
    private readonly configService: ConfigService,
    @Logger(WebhookDeliveryService.name) private readonly logger: LoggerService,
  ) {
    this.disableRetryCron = this.configService.get<string>('DISABLE_WEBHOOK_RETRY_CRON') === 'true';
    this.disableCleanupCron = this.configService.get<string>('DISABLE_WEBHOOK_CLEANUP_CRON') === 'true';
  }

  async getDeliveries(organizationId: string) {
    return this.repo.findManyForOrganization(organizationId);
  }

  async scheduleDelivery(webhook: Webhook, event: WebhookEventDTO): Promise<WebhookDelivery> {
    const payloadWithMetadata = {
      eventType: event.eventType,
      data: event.data,
      timestamp: event.timestamp,
    };

    const delivery = await this.repo.create(webhook.id, event.eventType, payloadWithMetadata);

    setImmediate(() => this.attemptDelivery(delivery.id, webhook));

    return delivery;
  }

  async attemptDelivery(deliveryId: string, webhook?: Webhook): Promise<void> {
    try {
      const delivery = await this.repo.findById(deliveryId);

      if (!delivery) {
        this.logger.error(`Delivery ${deliveryId} not found`);
        return;
      }

      const targetWebhook = webhook || delivery.webhook;
      if (!targetWebhook) {
        this.logger.error(`Webhook not found for delivery ${deliveryId}`);
        return;
      }

      if (!targetWebhook.isActive) {
        this.logger.debug(`Webhook ${targetWebhook.id} is inactive, skipping delivery`);
        await this.repo.updateToFailed(deliveryId, 'Webhook is inactive');
        return;
      }

      await this.repo.incrementAttempts(deliveryId);

      const signature = this.generateSignature(delivery.payload, targetWebhook.secret);
      const headers = {
        'Content-Type': 'application/json',
        [WebhookHeaders.SIGNATURE]: signature,
        [WebhookHeaders.EVENT]: delivery.eventType,
        [WebhookHeaders.DELIVERY]: delivery.id,
        [WebhookHeaders.TIMESTAMP]: new Date().toISOString(),
        [WebhookHeaders.USER_AGENT]: WebhookConfig.USER_AGENT,
      };

      // DNS-rebinding guard: pin the pre-validated IP into the agent so there is no TOCTOU window between check and connect
      const { address } = await assertSafeDeliveryUrl(targetWebhook.endpoint);
      const rawHostname = new URL(targetWebhook.endpoint).hostname;
      const sniHostname =
        rawHostname.startsWith('[') && rawHostname.endsWith(']') ? rawHostname.slice(1, -1) : rawHostname;
      const httpsAgent = new PinnedIpHttpsAgent(address, sniHostname);

      const payloadBytes = Buffer.byteLength(JSON.stringify(delivery.payload));
      if (payloadBytes > WebhookConfig.MAX_PAYLOAD_BYTES) {
        await this.repo.updateToFailed(
          deliveryId,
          `Payload ${payloadBytes} bytes exceeds limit of ${WebhookConfig.MAX_PAYLOAD_BYTES} bytes`,
        );
        return;
      }

      this.logger.debug(`Attempting webhook delivery to: ${targetWebhook.endpoint} (pinned to ${address})`);
      this.logger.debug(`Delivery ${delivery.id} (${delivery.eventType}) payload ${payloadBytes} bytes`);

      const response = await firstValueFrom(
        this.httpService.post(targetWebhook.endpoint, delivery.payload, {
          headers,
          timeout: WebhookConfig.TIMEOUT,
          maxBodyLength: WebhookConfig.MAX_PAYLOAD_BYTES,
          maxContentLength: WebhookConfig.MAX_PAYLOAD_BYTES,
          validateStatus: null,
          httpsAgent,
        }),
      );

      if (response.status >= 200 && response.status < 300) {
        await this.repo.updateToSuccess(deliveryId, response);

        await this.webhookService.resetFailureCount(targetWebhook.id);
        this.logger.debug(`Webhook delivery ${delivery.id} successful`);
      } else {
        this.logger.warn(`Webhook delivery failed with status ${response.status}: ${response.statusText}`);
        const axiosError = new AxiosError(
          `HTTP ${response.status}: ${response.statusText}`,
          response.status.toString(),
          response.config,
          response.request,
          response,
        );
        throw axiosError;
      }
    } catch (error) {
      await this.handleDeliveryError(deliveryId, error);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async processRetries(): Promise<void> {
    if (this.disableRetryCron) {
      return;
    }

    let locked: { id: string }[];
    try {
      locked = await this.repo.getLockedDeliveries(this.instanceId);
    } catch (error) {
      this.logger.error(`[webhook-retry-cron] Failed to acquire locks: ${getErrorMessage(error)}`);
      return;
    }

    if (locked.length > 0) {
      this.logger.log(`[webhook-retry-cron] Acquired ${locked.length} deliveries for retry`);
      const retriesToProcess = await this.repo.getRetriesToProcess(locked);

      const concurrencyLimit = 10;
      for (let i = 0; i < retriesToProcess.length; i += concurrencyLimit) {
        const batch = retriesToProcess.slice(i, i + concurrencyLimit);

        await Promise.all(
          batch.map(async (delivery) => {
            try {
              await this.attemptDelivery(delivery.id, delivery.webhook);
            } catch (error) {
              this.logger.error(`Error processing retry for delivery ${delivery.id}:`, getErrorMessage(error));
            }
          }),
        );

        const batchIds = batch.map((d) => d.id);
        await this.repo.releaseLockBatch(batchIds);
      }
    }
  }

  async getDeliveryDetails(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = await this.repo.getDeliveryDetails(deliveryId);

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

    return delivery;
  }

  async retryDelivery(deliveryId: string): Promise<WebhookDelivery> {
    const delivery = await this.repo.findById(deliveryId);

    if (!delivery) {
      throw new NotFoundException('Delivery not found');
    }

    if (delivery.status === DeliveryStatus.RETRYING || delivery.status === DeliveryStatus.PENDING) {
      throw new BadRequestException('Cannot retry pending or retrying delivery');
    }

    if (!delivery.webhook.isActive) {
      await this.webhookRepository.reactivateWebhook(delivery.webhook.id);

      this.logger.log(`Reactivated webhook ${delivery.webhook.id} due to manual retry`);
    }

    const updated = await this.repo.resetForImmediateRetry(deliveryId);

    const updatedWebhook = await this.webhookRepository.findById(delivery.webhook.id);

    setImmediate(() => this.attemptDelivery(deliveryId, updatedWebhook));

    return updated;
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldDeliveries(daysToKeep = 30): Promise<number> {
    if (this.disableCleanupCron) {
      return 0;
    }

    const deleteResult = await this.repo.cleanupOldDeliveries(daysToKeep);

    const releasedLocks = await this.repo.releaseExpiredLocks();

    this.logger.log(
      `Cleaned up ${deleteResult.count} old webhook deliveries and released ${releasedLocks.count} expired locks`,
    );

    return deleteResult.count;
  }

  private async handleDeliveryError(deliveryId: string, error: any): Promise<void> {
    this.logger.error(`Webhook delivery ${deliveryId} failed:`, (error as Error).message);

    const delivery = await this.repo.findById(deliveryId);

    if (!delivery) return;

    let errorMessage = getErrorMessage(error);

    if (errorMessage.toLowerCase().includes('timeout')) {
      errorMessage = errorMessage.replace(/timeout/gi, 'Timeout');
    }

    const httpStatus = this.getHttpStatus(error);
    const responseBody = this.getResponseBody(error);

    const updateData: any = {
      status: DeliveryStatus.FAILED,
      errorMessage: truncateString(errorMessage, 500),
      httpStatus,
      responseBody: truncateString(responseBody, 1000),
    };

    const isPermanentFailure = error instanceof SsrfBlockedError;
    if (!isPermanentFailure && delivery.attempts < WebhookConfig.MAX_RETRIES) {
      const retryDelay = WebhookConfig.RETRY_DELAYS[delivery.attempts - 1] || 5;
      const retryAt = new Date(Date.now() + retryDelay * 60 * 1000);
      retryAt.setSeconds(0, 0);
      updateData.nextRetryAt = retryAt;
      updateData.status = DeliveryStatus.RETRYING;

      this.logger.log(`Scheduling retry for delivery ${delivery.id} at ${retryAt.toISOString()}`);
    } else {
      await this.webhookService.incrementFailureCount(delivery.webhook.id);
    }

    await this.repo.update(deliveryId, updateData);
  }

  private async releaseLock(deliveryId: string): Promise<void> {
    await this.repo.releaseLock(deliveryId);
  }

  private generateSignature(payload: any, secret: string): string {
    const body = JSON.stringify(payload);
    const hmac = crypto.createHmac(WebhookConfig.SIGNATURE_ALGORITHM, secret);
    hmac.update(body, 'utf8');
    return `${WebhookConfig.SIGNATURE_ALGORITHM}=${hmac.digest('hex')}`;
  }

  private getHttpStatus(error: any): number | null {
    if (error instanceof AxiosError && error.response) {
      return error.response.status;
    }
    return null;
  }

  private getResponseBody(error: any): string | null {
    if (error instanceof AxiosError && error.response?.data) {
      return JSON.stringify(error.response.data);
    }
    return null;
  }
}
