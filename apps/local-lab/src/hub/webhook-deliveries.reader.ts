import { Injectable, Logger } from '@nestjs/common';

import { getErrorMessage } from '@repo/utils';
import { maskEmbeddedDsns, redactPayloadCapped, redactTextCapped } from '../common/redact';
import type { WebhookDeliveryPage, WebhookDeliveryRow } from '../contract';
import { PgService } from '../datastore/pg.service';
import { WEBHOOK_DELIVERIES_SQL, WebhookDeliverySqlRowSchema, type WebhookDeliverySqlRow } from './hub-sql';

export interface WebhookDeliveryQuery {
  status: string | null;
  webhookId: string | null;
  limit: number;
  offset: number;
}

// the endpoint's own response is arbitrary third-party text, so it is capped the same way a payload is
const RESPONSE_BODY_CAP = 2000;
const ERROR_MESSAGE_CAP = 1000;

function toRow(row: WebhookDeliverySqlRow): WebhookDeliveryRow {
  const payload = redactPayloadCapped(row.payload);
  const body = row.responseBody === null ? null : redactTextCapped(row.responseBody, RESPONSE_BODY_CAP);
  return {
    id: row.id,
    webhookId: row.webhookId,
    // a webhook url can carry basic-auth userinfo, which is a credential like every other
    endpoint: row.endpoint === null ? null : maskEmbeddedDsns(row.endpoint),
    eventType: row.eventType,
    status: row.status,
    httpStatus: row.httpStatus,
    attempts: row.attempts,
    errorMessage: row.errorMessage === null ? null : redactTextCapped(row.errorMessage, ERROR_MESSAGE_CAP).value,
    idempotencyKey: row.idempotencyKey,
    nextRetryAtMs: row.nextRetryAt,
    createdAtMs: row.createdAt,
    deliveredAtMs: row.deliveredAt,
    lockedBy: row.processingLockedBy,
    lockedAtMs: row.processingLockedAt,
    lockExpiresAtMs: row.processingLockExpires,
    payload: payload.value,
    payloadTruncated: payload.truncated,
    responseBody: body === null ? null : body.value,
    responseBodyTruncated: body?.truncated ?? false,
  };
}

@Injectable()
export class WebhookDeliveriesReaderService {
  private readonly log = new Logger(WebhookDeliveriesReaderService.name);

  constructor(private readonly pg: PgService) {}

  async list(query: WebhookDeliveryQuery): Promise<WebhookDeliveryPage> {
    try {
      const { rows, skipped } = await this.pg.readTyped(
        WEBHOOK_DELIVERIES_SQL,
        [query.status, query.webhookId, query.limit, query.offset],
        WebhookDeliverySqlRowSchema,
      );
      if (skipped > 0) this.log.warn(`webhook deliveries: skipped ${skipped} unreadable row(s)`);
      return { rows: rows.map(toRow), skipped, readError: null };
    } catch (error) {
      const readError = getErrorMessage(error);
      this.log.debug(`webhook delivery read failed: ${readError}`);
      return { rows: [], skipped: 0, readError };
    }
  }
}
