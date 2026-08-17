import { WebhookEventTypeSchema, type WebhookEventTypeEnum } from '@repo/api-client';
import { fail } from '../../ui/format.js';
import type { PaginationMeta } from '../../ui/table.js';
import type { CliApiClient } from '../client.js';

export interface WebhookListItem {
  id: string;
  endpoint: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  createdAt: string;
  updatedAt: string | null;
}

export interface WebhookDeliveryListItem {
  id: string;
  webhookId: string;
  webhookEndpoint: string;
  eventType: string;
  status: string;
  statusCode: number | null;
  attemptNumber: number;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export interface WebhookStatsData {
  total: number;
  active: number;
  failed: number;
  recentDeliveries: {
    id: string;
    webhookId: string;
    eventType: string;
    status: string;
    httpStatus: number | null;
    attempts: number;
    createdAt: string;
    deliveredAt: string | null;
    webhook?: { endpoint: string; description: string | null };
  }[];
}

const VALID_EVENTS = WebhookEventTypeSchema.options;

function mapWebhook(wh: {
  id: string;
  endpoint: string;
  description: string | null;
  events: string[];
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date | null;
}): WebhookListItem {
  return {
    id: wh.id,
    endpoint: wh.endpoint,
    description: wh.description,
    events: wh.events,
    isActive: wh.isActive,
    createdAt: String(wh.createdAt),
    updatedAt: wh.updatedAt ? String(wh.updatedAt) : null,
  };
}

function mapWebhookDelivery(d: {
  id: string;
  webhookId: string;
  webhookEndpoint: string;
  eventType: string;
  status: string;
  statusCode: number | null;
  attemptNumber: number;
  error: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}): WebhookDeliveryListItem {
  return {
    id: d.id,
    webhookId: d.webhookId,
    webhookEndpoint: d.webhookEndpoint,
    eventType: d.eventType,
    status: d.status,
    statusCode: d.statusCode,
    attemptNumber: d.attemptNumber,
    error: d.error,
    createdAt: String(d.createdAt),
    deliveredAt: d.deliveredAt ? String(d.deliveredAt) : null,
  };
}

export function parseWebhookEvents(csv: string): string[] {
  const events = csv.split(',').map((e) => e.trim());
  for (const event of events) {
    if (!VALID_EVENTS.includes(event as (typeof VALID_EVENTS)[number])) {
      fail(`Invalid event "${event}". Must be one of:\n  ${VALID_EVENTS.join('\n  ')}`);
    }
  }
  return events;
}

export async function listWebhooks(
  client: CliApiClient,
  query: { page: number; pageSize: number; sort?: string; search?: string },
): Promise<{ data: WebhookListItem[]; meta: PaginationMeta }> {
  const result = await client.listWebhooks({
    query: {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.sort ? { sort: query.sort } : {}),
      ...(query.search ? { search: query.search } : {}),
    },
  });

  if (result.status !== 200) {
    throw new Error(`Failed to list webhooks (${result.status})`);
  }

  return { data: result.body.data.map(mapWebhook), meta: result.body.meta };
}

export async function getWebhook(client: CliApiClient, webhookId: string): Promise<WebhookListItem> {
  const result = await client.getWebhook({ params: { webhookId } });

  if (result.status === 404) {
    throw new Error(`Webhook not found: ${webhookId}`);
  }

  if (result.status !== 200) {
    throw new Error(`Failed to get webhook (${result.status})`);
  }

  return mapWebhook(result.body);
}

export async function listWebhookDeliveries(
  client: CliApiClient,
  query: { page: number; pageSize: number; sort?: string; search?: string },
): Promise<{ data: WebhookDeliveryListItem[]; meta: PaginationMeta }> {
  const result = await client.getWebhookDeliveries({
    query: {
      page: query.page,
      pageSize: query.pageSize,
      ...(query.sort ? { sort: query.sort } : {}),
      ...(query.search ? { search: query.search } : {}),
    },
  });

  if (result.status !== 200) {
    throw new Error(`Failed to list webhook deliveries (${result.status})`);
  }

  return { data: result.body.data.map(mapWebhookDelivery), meta: result.body.meta };
}

export interface WebhookCreatedResult extends WebhookListItem {
  secret: string;
}

export async function createWebhook(
  client: CliApiClient,
  data: { endpoint: string; description?: string; events: string[]; isActive: boolean },
): Promise<WebhookCreatedResult> {
  const result = await client.createWebhook({
    body: {
      endpoint: data.endpoint,
      ...(data.description ? { description: data.description } : {}),
      events: data.events as [WebhookEventTypeEnum, ...WebhookEventTypeEnum[]],
      isActive: data.isActive,
    },
  });

  if (result.status !== 201) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to create webhook (${result.status})`);
  }

  return {
    ...mapWebhook({ ...result.body, updatedAt: null }),
    secret: result.body.secret,
  };
}

export async function updateWebhook(
  client: CliApiClient,
  webhookId: string,
  data: { endpoint: string; description?: string; events: string[]; isActive?: boolean },
): Promise<WebhookListItem> {
  const result = await client.updateWebhook({
    params: { webhookId },
    body: {
      endpoint: data.endpoint,
      ...(data.description !== undefined ? { description: data.description } : {}),
      events: data.events as [WebhookEventTypeEnum, ...WebhookEventTypeEnum[]],
      ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
    },
  });

  if (result.status === 404) {
    throw new Error(`Webhook not found: ${webhookId}`);
  }

  if (result.status !== 200) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to update webhook (${result.status})`);
  }

  return mapWebhook(result.body);
}

export async function deleteWebhook(client: CliApiClient, webhookId: string): Promise<void> {
  const result = await client.deleteWebhook({
    params: { webhookId },
    body: {},
  });

  if (result.status === 404) {
    throw new Error(`Webhook not found: ${webhookId}`);
  }

  if (result.status !== 204) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to delete webhook (${result.status})`);
  }
}

export async function retryWebhookDelivery(client: CliApiClient, deliveryId: string): Promise<WebhookDeliveryListItem> {
  const result = await client.retryWebhookDelivery({
    params: { deliveryId },
    body: {},
  });

  if (result.status === 404) {
    throw new Error(`Delivery not found: ${deliveryId}`);
  }

  if (result.status !== 200) {
    const errorBody = result.body as { message?: string };
    throw new Error(errorBody?.message ?? `Failed to retry delivery (${result.status})`);
  }

  return mapWebhookDelivery(result.body);
}

export async function getWebhookStats(client: CliApiClient): Promise<WebhookStatsData> {
  const result = await client.getWebhookStats();

  if (result.status !== 200) {
    throw new Error(`Failed to get webhook stats (${result.status})`);
  }

  const s = result.body;
  return {
    total: s.total,
    active: s.active,
    failed: s.failed,
    recentDeliveries: s.recentDeliveries.map((d) => ({
      id: d.id,
      webhookId: d.webhookId,
      eventType: d.eventType,
      status: d.status,
      httpStatus: d.httpStatus,
      attempts: d.attempts,
      createdAt: String(d.createdAt),
      deliveredAt: d.deliveredAt ? String(d.deliveredAt) : null,
      webhook: d.webhook ? { endpoint: d.webhook.endpoint, description: d.webhook.description } : undefined,
    })),
  };
}
