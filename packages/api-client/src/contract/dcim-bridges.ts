import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { BridgeResponseSchema } from '../schemas/dcim-bridges';
import { PaginationQuerySchema, createPaginatedResponseSchema } from '../schemas/pagination';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

export const dcimBridgesRoutes = c.router({
  getBridges: {
    method: 'GET',
    path: '/bridges',
    query: PaginationQuerySchema.extend({
      zoneId: z
        .string()
        .uuid()
        .optional()
        .describe('Restrict the result to bridges in this zone (data center). Omit for all org bridges.'),
    }),
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(BridgeResponseSchema),
    },
    summary: 'Get all bridges for the current organization',
    description:
      'Returns a paginated list of bridge devices registered to the current organization, optionally filtered to a single zone. Bridges facilitate connectivity between infrastructure and the platform.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getBridgeById: {
    method: 'GET',
    path: '/bridges/:bridgeId',
    pathParams: z.object({ bridgeId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: BridgeResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get bridge by ID',
    description:
      'Returns the full bridge record for the given ID. Returns 404 if the bridge does not exist or does not belong to the current organization.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
