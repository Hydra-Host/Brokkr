import { z } from 'zod';

export function isPrivateIPv4(a: number, b: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

export function isPublicHttpsUrl(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();

  if (host.startsWith('[') && host.endsWith(']')) {
    const addr = host.slice(1, -1);
    if (addr === '::1' || addr === '::') return false;
    const mappedV4 = addr.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
    if (mappedV4?.[1]) {
      const hi = parseInt(mappedV4[1], 16);
      const a = (hi >> 8) & 0xff;
      const b = hi & 0xff;
      if (isPrivateIPv4(a, b)) return false;
    }
    if (/^f[cd]/i.test(addr)) return false;
    if (/^fe[89ab]/i.test(addr)) return false;
    return true;
  }

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;

  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4) {
    if (isPrivateIPv4(Number(ipv4[1]), Number(ipv4[2]))) return false;
  }

  return true;
}

const webhookEndpoint = z.string().url({ message: 'Endpoint must be a valid URL' }).refine(isPublicHttpsUrl, {
  message: 'Endpoint must be a public HTTPS URL — private IPs, localhost, and non-HTTPS schemes are not allowed',
});

const DeliveryStatusValues = ['PENDING', 'SUCCESS', 'FAILED', 'RETRYING'] as const;
const WebhookEventTypeValues = [
  'DEVICE_LISTING_UPDATED',
  'DEVICE_LISTING_CREATED',
  'DEVICE_LISTING_DECOMMISSIONED',
  'DEPLOYMENT_INTERRUPTED',
  'DEPLOYMENT_INTERRUPTION_COMPLETED',
] as const;

export const WebhookEventTypeSchema = z
  .enum(WebhookEventTypeValues)
  .describe('Type of webhook event that triggers delivery');
export type WebhookEventTypeEnum = z.infer<typeof WebhookEventTypeSchema>;
export const DeliveryStatusSchema = z
  .enum(DeliveryStatusValues)
  .describe('Current delivery status of a webhook payload');

export const CreateWebhookRequestSchema = z.object({
  endpoint: webhookEndpoint.describe('URL that will receive webhook payloads'),
  description: z.string().optional().describe('Optional human-readable description of the webhook'),
  events: z.array(WebhookEventTypeSchema).min(1).describe('Event types this webhook subscribes to'),
  isActive: z.boolean().default(true).describe('Whether the webhook is enabled for delivery'),
});

export type CreateWebhookRequest = z.infer<typeof CreateWebhookRequestSchema>;

export const UpdateWebhookRequestSchema = z.object({
  endpoint: webhookEndpoint.describe('Updated URL for webhook delivery'),
  description: z.string().optional().describe('Updated description of the webhook'),
  events: z.array(WebhookEventTypeSchema).min(1).describe('Updated event type subscriptions'),
  isActive: z.boolean().optional().describe('Whether the webhook should be active'),
});

export type UpdateWebhookRequest = z.infer<typeof UpdateWebhookRequestSchema>;

export const WebhookCreatedResponseSchema = z.object({
  id: z.string().uuid().describe('Unique identifier of the created webhook'),
  endpoint: z.string().describe('Configured delivery endpoint URL'),
  description: z.string().nullable().describe('Human-readable description of the webhook'),
  events: z.array(WebhookEventTypeSchema).describe('Event types this webhook is subscribed to'),
  isActive: z.boolean().describe('Whether the webhook is currently active'),
  createdAt: z.coerce.date().describe('Timestamp when the webhook was created'),
  secret: z.string().describe('Signing secret for verifying webhook payloads'),
});

export type WebhookCreatedResponse = z.infer<typeof WebhookCreatedResponseSchema>;

export const WebhookSchema = z.object({
  id: z.string().uuid().describe('Unique identifier of the webhook'),
  endpoint: z.string().describe('Delivery endpoint URL'),
  description: z.string().nullable().describe('Human-readable description of the webhook'),
  events: z.array(WebhookEventTypeSchema).describe('Event types this webhook is subscribed to'),
  isActive: z.boolean().describe('Whether the webhook is currently active'),
  createdAt: z.coerce.date().describe('Timestamp when the webhook was created'),
  updatedAt: z.coerce.date().nullable().describe('Timestamp of the last update, if any'),
});

export type Webhook = z.infer<typeof WebhookSchema>;

export const WebhookIdParamsSchema = z.object({
  webhookId: z.string().uuid().describe('Unique identifier of the target webhook'),
});

export const DeliveryIdParamsSchema = z.object({
  deliveryId: z.string().uuid().describe('Unique identifier of the target delivery'),
});

export const WebhookDeliverySchema = z.object({
  id: z.string().uuid().describe('Unique identifier of the delivery attempt'),
  webhookId: z.string().uuid().describe('Webhook this delivery belongs to'),
  webhookEndpoint: z.string().describe('Endpoint URL the payload was sent to'),
  eventType: WebhookEventTypeSchema.describe('Event type that triggered this delivery'),
  payload: z.unknown().describe('Serialized event payload delivered to the endpoint'),
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'RETRYING']).describe('Current delivery status'),
  statusCode: z.number().nullable().describe('HTTP status code returned by the endpoint'),
  responseBody: z.string().nullable().describe('Response body returned by the endpoint'),
  attemptNumber: z.number().describe('Number of delivery attempts made'),
  error: z.string().nullable().describe('Error message if the delivery failed'),
  createdAt: z.coerce.date().describe('Timestamp when the delivery was queued'),
  deliveredAt: z.coerce.date().nullable().describe('Timestamp when the delivery succeeded'),
});

export type WebhookDeliveryResponse = z.infer<typeof WebhookDeliverySchema>;

export const WebhookStatsSchema = z.object({
  total: z.number().describe('Total number of registered webhooks'),
  active: z.number().describe('Number of currently active webhooks'),
  failed: z.number().describe('Number of recent failed deliveries'),
  recentDeliveries: z
    .array(
      z.object({
        id: z.string().uuid().describe('Unique identifier of the delivery'),
        webhookId: z.string().uuid().describe('Webhook this delivery belongs to'),
        eventType: WebhookEventTypeSchema.describe('Event type that triggered this delivery'),
        payload: z.unknown().describe('Serialized event payload'),
        status: DeliveryStatusSchema.describe('Current delivery status'),
        httpStatus: z.number().nullable().describe('HTTP status code from the endpoint response'),
        responseBody: z.string().nullable().describe('Response body from the endpoint'),
        errorMessage: z.string().nullable().describe('Error message if the delivery failed'),
        attempts: z.number().describe('Total number of delivery attempts'),
        nextRetryAt: z.coerce.date().nullable().describe('Scheduled time for the next retry attempt'),
        createdAt: z.coerce.date().describe('Timestamp when the delivery was created'),
        deliveredAt: z.coerce.date().nullable().describe('Timestamp when the delivery succeeded'),
        webhook: z
          .object({
            endpoint: z.string().describe('Webhook endpoint URL'),
            description: z.string().nullable().describe('Human-readable webhook description'),
          })
          .optional()
          .describe('Associated webhook summary'),
      }),
    )
    .describe('List of recent webhook deliveries'),
});

export type WebhookStats = z.infer<typeof WebhookStatsSchema>;
