import { isPrivateIPv4, isPublicHttpsUrl } from '@repo/api-client';
import { DeliveryStatus, WebhookDelivery, WebhookEventType } from '@repo/database';
import * as dns from 'dns';
import * as http from 'http';
import * as https from 'https';
import { createZodDto } from 'nestjs-zod';
import * as net from 'net';
import { BRAND_NAME } from 'src/common/branding';
import * as stream from 'stream';
import * as tls from 'tls';
import { z } from 'zod';

// The async DNS/IP-pinning layer stays here — node dns/tls must not enter the browser-safe @repo/api-client package.
export { isPrivateIPv4, isPublicHttpsUrl };

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

/** Allowlist — only global unicast (2000::/3) passes; caller must handle IPv6-mapped IPv4 first and pass lowercased input. */
export function isReservedIPv6(v6Lower: string): boolean {
  if (v6Lower === '::1' || v6Lower === '::') return true;
  if (v6Lower.startsWith('ff')) return true;
  if (/^f[cd]/i.test(v6Lower)) return true;
  if (/^fe/i.test(v6Lower)) return true;
  if (/^0*100:/i.test(v6Lower)) return true;
  if (v6Lower.startsWith('64:ff9b:')) return true;
  if (!/^[23]/i.test(v6Lower)) return true;
  if (/^2001:0?db8:/i.test(v6Lower)) return true;
  if (/^2001:0{0,4}:/i.test(v6Lower)) return true;
  if (v6Lower.startsWith('2002:')) return true;
  return false;
}

/** Returns a validated public IP for the caller to pin the connection to — closes the DNS TOCTOU window. */
export async function assertSafeDeliveryUrl(urlString: string): Promise<{ address: string; family: 4 | 6 }> {
  const { hostname } = new URL(urlString);

  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
    return { address: hostname, family: 4 };
  }
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return { address: hostname.slice(1, -1), family: 6 };
  }

  const PERMANENT_DNS_CODES = new Set(['ENODATA', 'ENOTFOUND', 'ENOTIMP', 'EREFUSED']);

  const ipv4Addresses: string[] = [];
  const ipv6Addresses: string[] = [];
  let anyTransientDnsError = false;

  try {
    ipv4Addresses.push(...(await dns.promises.resolve4(hostname)));
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      !PERMANENT_DNS_CODES.has(error.code)
    ) {
      anyTransientDnsError = true;
    }
  }

  try {
    ipv6Addresses.push(...(await dns.promises.resolve6(hostname)));
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      !PERMANENT_DNS_CODES.has(error.code)
    ) {
      anyTransientDnsError = true;
    }
  }

  if (ipv4Addresses.length === 0 && ipv6Addresses.length === 0) {
    if (anyTransientDnsError) {
      throw new Error(`DNS lookup for webhook endpoint "${hostname}" failed — will retry`);
    }
    throw new SsrfBlockedError(`Webhook endpoint hostname "${hostname}" could not be resolved`);
  }

  for (const addr of ipv4Addresses) {
    const m = addr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m && isPrivateIPv4(Number(m[1]), Number(m[2]))) {
      throw new SsrfBlockedError(`Webhook endpoint resolves to a private or reserved IP address`);
    }
  }

  for (const addr of ipv6Addresses) {
    const v6 = addr.toLowerCase();

    const mappedHex = v6.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      if (isPrivateIPv4((hi >> 8) & 0xff, hi & 0xff)) {
        throw new SsrfBlockedError(`Webhook endpoint resolves to a private or reserved IP address`);
      }
      continue;
    }

    const mappedDotted = v6.match(/^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (mappedDotted) {
      if (isPrivateIPv4(Number(mappedDotted[1]), Number(mappedDotted[2]))) {
        throw new SsrfBlockedError(`Webhook endpoint resolves to a private or reserved IP address`);
      }
      continue;
    }

    if (isReservedIPv6(v6)) {
      throw new SsrfBlockedError(`Webhook endpoint resolves to a private or reserved IP address`);
    }
  }

  if (ipv4Addresses.length > 0) {
    return { address: ipv4Addresses[0], family: 4 };
  }
  return { address: ipv6Addresses[0], family: 6 };
}

/** Connects to the pre-validated IP (closes the TOCTOU window) while keeping the hostname as SNI so certificate validation still works. */
export class PinnedIpHttpsAgent extends https.Agent {
  private readonly validatedIp: string;
  private readonly sniHostname: string;

  constructor(validatedIp: string, sniHostname: string) {
    super({ keepAlive: false });
    this.validatedIp = validatedIp;
    this.sniHostname = sniHostname;
  }

  createConnection(
    options: http.ClientRequestArgs,
    callback: ((err: NodeJS.ErrnoException | null, socket: stream.Duplex) => void) | undefined,
  ): net.Socket {
    const port = typeof options.port === 'string' ? parseInt(options.port, 10) : (options.port ?? 443);
    const socket = tls.connect({
      host: this.validatedIp,
      port,
      servername: this.sniHostname,
      rejectUnauthorized: true,
      ALPNProtocols: ['http/1.1'],
    });
    if (callback) {
      const onConnect = () => {
        socket.removeListener('error', onError);
        callback(null, socket);
      };
      const onError = (err: NodeJS.ErrnoException) => {
        socket.removeListener('secureConnect', onConnect);
        callback(err, socket);
      };
      socket.once('secureConnect', onConnect);
      socket.once('error', onError);
    }
    return socket;
  }
}

const webhookEndpoint = z.string().url({ message: 'Endpoint must be a valid URL' }).refine(isPublicHttpsUrl, {
  message: 'Endpoint must be a public HTTPS URL — private IPs, localhost, and non-HTTPS schemes are not allowed',
});

export const CreateWebhookSchema = z.object({
  endpoint: webhookEndpoint,
  description: z.string().optional(),
  events: z.array(z.nativeEnum(WebhookEventType)).min(1),
  isActive: z.boolean().default(true),
});

export class CreateWebhookDTO extends createZodDto(CreateWebhookSchema) {}

export const WebhookCreatedResponseSchema = z.object({
  id: z.string().uuid(),
  endpoint: z.string(),
  description: z.string().nullable(),
  events: z.array(z.nativeEnum(WebhookEventType)),
  isActive: z.boolean(),
  createdAt: z.date(),
  secret: z.string(),
});

export const UpdateWebhookSchema = z.object({
  endpoint: webhookEndpoint,
  description: z.string().optional(),
  events: z.array(z.nativeEnum(WebhookEventType)).min(1),
  isActive: z.boolean().optional(),
});
export class UpdateWebhookDTO extends createZodDto(UpdateWebhookSchema) {}

export const WebhookEventSchema = z.object({
  eventType: z.nativeEnum(WebhookEventType),
  data: z.unknown(),
  timestamp: z.date().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type WebhookEventDTO = z.infer<typeof WebhookEventSchema>;

export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

// Customer-facing view — internal queue/worker fields must never reach the API response.
export interface WebhookDeliveryWithWebhook
  extends Omit<
    WebhookDelivery,
    'idempotencyKey' | 'processingLockedBy' | 'processingLockedAt' | 'processingLockExpires'
  > {
  webhook?: {
    endpoint: string;
    description: string | null;
  };
}

export const WebhookDeliverySchema = z.object({
  id: z.string().uuid(),
  webhookId: z.string().uuid(),
  webhookEndpoint: z.string(),
  eventType: z.nativeEnum(WebhookEventType),
  payload: z.unknown(),
  status: z.enum(['PENDING', 'SUCCESS', 'FAILED', 'RETRYING']),
  statusCode: z.number().nullable(),
  responseBody: z.string().nullable(),
  attemptNumber: z.number(),
  error: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
});

export interface WebhookStats {
  total: number;
  active: number;
  failed: number;
  recentDeliveries: WebhookDeliveryWithWebhook[];
}

export const WebhookStatsSchema = z.object({
  total: z.number(),
  active: z.number(),
  failed: z.number(),
  recentDeliveries: z.array(
    z.object({
      id: z.string().uuid(),
      webhookId: z.string().uuid(),
      eventType: z.nativeEnum(WebhookEventType),
      payload: z.unknown(),
      status: z.nativeEnum(DeliveryStatus),
      httpStatus: z.number().nullable(),
      responseBody: z.string().nullable(),
      errorMessage: z.string().nullable(),
      attempts: z.number(),
      nextRetryAt: z.string().nullable(),
      createdAt: z.string(),
      deliveredAt: z.string().nullable(),
      webhook: z
        .object({
          endpoint: z.string(),
          description: z.string().nullable(),
        })
        .optional(),
    }),
  ),
});

export const WebhookHeaders = {
  SIGNATURE: 'X-Webhook-Signature',
  EVENT: 'X-Webhook-Event',
  DELIVERY: 'X-Webhook-Delivery',
  TIMESTAMP: 'X-Webhook-Timestamp',
  USER_AGENT: 'User-Agent',
} as const;

export const WebhookConfig = {
  MAX_RETRIES: 5,
  RETRY_DELAYS: [1, 2, 3, 4, 5],
  TIMEOUT: 10000,
  MAX_FAILURES_BEFORE_DISABLE: 10,
  MAX_PAYLOAD_BYTES: 1024 * 1024,
  SIGNATURE_ALGORITHM: 'sha256',
  USER_AGENT: `${BRAND_NAME}-Webhooks/1.0`,
} as const;
