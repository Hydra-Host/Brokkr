import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/index';
import { createPaginatedResponseSchema, PaginationQuerySchema } from '../schemas/pagination';
import {
  CreateWebhookRequestSchema,
  DeliveryIdParamsSchema,
  UpdateWebhookRequestSchema,
  WebhookCreatedResponseSchema,
  WebhookDeliverySchema,
  WebhookIdParamsSchema,
  WebhookSchema,
  WebhookStatsSchema,
} from '../schemas/webhooks';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses, authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const webhooksRoutes = c.router({
  createWebhook: {
    method: 'POST',
    path: '/organizations/webhooks',
    body: CreateWebhookRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      201: WebhookCreatedResponseSchema,
      400: ErrorResponseSchema,
    },
    summary: 'Create a new webhook',
    description:
      'Registers a new webhook endpoint for the current organization. The response includes the signing secret which is only returned at creation time.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  listWebhooks: {
    method: 'GET',
    path: '/organizations/webhooks',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(WebhookSchema),
    },
    summary: 'Get all webhooks for the active organization',
    description:
      'Returns a paginated list of all registered webhook endpoints for the organization, including their status and subscribed event types.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getWebhookDeliveries: {
    method: 'GET',
    path: '/organizations/webhooks/deliveries',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(WebhookDeliverySchema),
    },
    summary: 'Get webhook deliveries for the active organization',
    description:
      'Returns a paginated list of webhook delivery attempts across all endpoints. Includes delivery status, response codes, and timestamps.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getWebhookStats: {
    method: 'GET',
    path: '/organizations/webhooks/stats',
    responses: {
      ...authedErrorResponses,
      200: WebhookStatsSchema,
    },
    summary: 'Get webhook statistics for the active organization',
    description:
      'Returns aggregate delivery statistics including success rate, failure count, and average response time across all webhook endpoints.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getWebhook: {
    method: 'GET',
    path: '/organizations/webhooks/:webhookId',
    pathParams: WebhookIdParamsSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: WebhookSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get a specific webhook',
    description:
      'Returns the full configuration of a webhook endpoint by ID. Returns 403 if the webhook belongs to a different organization.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateWebhook: {
    method: 'PATCH',
    path: '/organizations/webhooks/:webhookId',
    pathParams: WebhookIdParamsSchema,
    body: UpdateWebhookRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: WebhookSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update a webhook',
    description:
      "Partially updates a webhook endpoint's configuration, such as its URL, subscribed events, or enabled status.",
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  deleteWebhook: {
    method: 'DELETE',
    path: '/organizations/webhooks/:webhookId',
    pathParams: WebhookIdParamsSchema,
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      204: z.void(),
      404: ErrorResponseSchema,
    },
    summary: 'Delete a webhook',
    description: 'Permanently removes a webhook endpoint and all its delivery history. This action cannot be undone.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  retryWebhookDelivery: {
    method: 'POST',
    path: '/organizations/webhooks/deliveries/:deliveryId/retry',
    pathParams: DeliveryIdParamsSchema,
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: WebhookDeliverySchema,
      404: ErrorResponseSchema,
    },
    summary: 'Retry a failed webhook delivery',
    description:
      'Re-sends the payload for a previously failed webhook delivery attempt. A new delivery record is created with the retry result.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
