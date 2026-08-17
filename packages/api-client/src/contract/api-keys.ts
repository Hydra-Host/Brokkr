import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  ApiKeyIdParamsSchema,
  ApiKeysQuerySchema,
  ApiKeyWithCreatorSchema,
  CreateApiKeyRequestSchema,
  CreatedApiKeySchema,
  UpdateApiKeyRequestSchema,
} from '../schemas/api-keys';
import { createPaginatedResponseSchema } from '../schemas/pagination';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses, authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const apiKeysRoutes = c.router({
  listApiKeys: {
    method: 'GET',
    path: '/organizations/api-keys',
    query: ApiKeysQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(ApiKeyWithCreatorSchema),
    },
    summary: 'List API keys for the active organization',
    description:
      'Returns a paginated list of all active API keys belonging to the current organization. Requires the API feature flag to be enabled. Supports filtering by creator email and sorting by creation date.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  createApiKey: {
    method: 'POST',
    path: '/organizations/api-keys',
    body: CreateApiKeyRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      201: CreatedApiKeySchema,
      400: ErrorResponseSchema,
    },
    summary: 'Create a new API key for the active organization',
    description:
      'Creates a new API key scoped to the current organization. The full key value is only returned once in the response and cannot be retrieved again. Requires the API feature flag to be enabled.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getApiKey: {
    method: 'GET',
    path: '/organizations/api-keys/:apiKeyId',
    pathParams: ApiKeyIdParamsSchema,
    responses: {
      ...authedErrorResponses,
      200: ApiKeyWithCreatorSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get a specific API key',
    description:
      'Returns metadata for a specific API key. The full key value is not included — only the prefix and start characters are returned. Requires the API feature flag to be enabled.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateApiKey: {
    method: 'PATCH',
    path: '/organizations/api-keys/:apiKeyId',
    pathParams: ApiKeyIdParamsSchema,
    body: UpdateApiKeyRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: ApiKeyWithCreatorSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update an API key’s permission scope',
    description:
      'Sets an explicit permission restriction or restores inheritance from the owner’s live permissions. Explicit scope remains capped by the owner’s access and does not rotate the key’s secret.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  deleteApiKey: {
    method: 'DELETE',
    path: '/organizations/api-keys/:apiKeyId',
    pathParams: ApiKeyIdParamsSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      204: z.void(),
      404: ErrorResponseSchema,
    },
    summary: 'Delete an API key',
    description:
      'Permanently deletes an API key. Any requests using this key will immediately fail authentication. Requires the API feature flag to be enabled.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
