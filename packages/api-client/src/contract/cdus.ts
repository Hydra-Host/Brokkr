import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { CduListResponseSchema, CduSchema, CdusQuerySchema, UpdateCduRequestSchema } from '../schemas/cdus';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

const DeviceIdParamSchema = z.object({
  deviceId: z.string().uuid(),
});

export const cduRoutes = c.router({
  listCdus: {
    method: 'GET',
    path: '/cdus',
    query: CdusQuerySchema,
    responses: { ...authedErrorResponses, 200: CduListResponseSchema },
    summary: 'List CDUs',
    description:
      'Returns a paginated list of coolant distribution units. Supports `page`/`pageSize`/`sort`/`search`, a `zoneId` filter, and a `decommissioned` flag to list soft-deleted CDUs instead.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getCduById: {
    method: 'GET',
    path: '/cdus/:deviceId',
    pathParams: DeviceIdParamSchema,
    responses: { ...authedErrorResponses, 200: CduSchema, 404: ErrorResponseSchema },
    summary: 'Get CDU by device ID',
    description: 'Returns a single coolant distribution unit by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updateCdu: {
    method: 'PATCH',
    path: '/cdus/:deviceId',
    pathParams: DeviceIdParamSchema,
    body: UpdateCduRequestSchema,
    responses: { ...authedErrorResponses, 200: CduSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
    summary: 'Update CDU',
    description: 'Updates the editable fields of a coolant distribution unit by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  decommissionCdu: {
    method: 'DELETE',
    path: '/cdus/:deviceId',
    pathParams: DeviceIdParamSchema,
    body: z.object({}),
    responses: { ...authedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Decommission CDU',
    description: 'Decommissions (soft-deletes) a coolant distribution unit by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
