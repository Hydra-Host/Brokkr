import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { CloudInitTemplateSchema, UpdateCloudInitTemplateSchema } from '../schemas/cloud-init-templates';
import { PaginationQuerySchema, createPaginatedResponseSchema } from '../schemas/pagination';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses, authedRoleGatedErrorResponses } from './responses';

const c = initContract();

const PUBLIC: RouteMetadata = { visibility: 'public' };

export const cloudInitTemplatesRoutes = c.router({
  listCloudInitTemplates: {
    method: 'GET',
    path: '/cloud-init-templates',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(CloudInitTemplateSchema),
    },
    metadata: PUBLIC,
    summary: 'List cloud-init templates',
    description:
      "Returns paginated cloud-init templates for the authenticated user's organization. Only active (non-deleted) templates are returned.",
  },

  updateCloudInitTemplate: {
    method: 'PATCH',
    path: '/cloud-init-templates/:id',
    pathParams: z.object({
      id: z.string().uuid().describe('Cloud-init template ID'),
    }),
    body: UpdateCloudInitTemplateSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: CloudInitTemplateSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    metadata: PUBLIC,
    summary: 'Update a cloud-init template',
    description:
      'Updates the name or content of a cloud-init template. Returns 409 if updated content matches an existing template in the same organization.',
  },

  deleteCloudInitTemplate: {
    method: 'DELETE',
    path: '/cloud-init-templates/:id',
    pathParams: z.object({
      id: z.string().uuid().describe('Cloud-init template ID'),
    }),
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      204: z.void(),
      404: ErrorResponseSchema,
    },
    metadata: PUBLIC,
    summary: 'Delete a cloud-init template',
    description: 'Permanently deletes a cloud-init template.',
  },
});
