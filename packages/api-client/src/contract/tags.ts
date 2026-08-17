import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/responses';
import { CreateTagRequestSchema, TagListQuerySchema, TagSchema, UpdateTagRequestSchema } from '../schemas/tags';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export const tagsRoutes = c.router({
  listTags: {
    method: 'GET',
    path: '/tags',
    query: TagListQuerySchema,
    responses: { ...authedErrorResponses, 200: z.array(TagSchema) },
    summary: 'List tags',
    description: 'Returns a list of tags, optionally filtered by organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getTag: {
    method: 'GET',
    path: '/tags/:id',
    pathParams: IdParamSchema,
    responses: { ...authedErrorResponses, 200: TagSchema, 404: ErrorResponseSchema },
    summary: 'Get tag by ID',
    description: 'Returns a single tag by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  createTag: {
    method: 'POST',
    path: '/tags',
    body: CreateTagRequestSchema,
    responses: { ...authedErrorResponses, 201: TagSchema, 400: ErrorResponseSchema, 409: ErrorResponseSchema },
    summary: 'Create tag',
    description: 'Creates a new tag within an organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updateTag: {
    method: 'PATCH',
    path: '/tags/:id',
    pathParams: IdParamSchema,
    body: UpdateTagRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: TagSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Update tag',
    description: 'Updates an existing tag by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  deleteTag: {
    method: 'DELETE',
    path: '/tags/:id',
    pathParams: IdParamSchema,
    body: z.object({}),
    responses: { ...authedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Delete tag',
    description: 'Deletes a tag by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
