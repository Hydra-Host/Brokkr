import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/responses';
import {
  RouterListResponseSchema,
  RouterSchema,
  RoutersQuerySchema,
  UpdateRouterRequestSchema,
} from '../schemas/routers';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

const DeviceIdParamSchema = z.object({
  deviceId: z.string().uuid(),
});

export const routerRoutes = c.router({
  listRouters: {
    method: 'GET',
    path: '/routers',
    query: RoutersQuerySchema,
    responses: { ...authedErrorResponses, 200: RouterListResponseSchema },
    summary: 'List routers',
    description:
      'Returns a paginated list of router-role devices. Supports `page`/`pageSize`/`sort`/`search`, a `zoneId` filter, and a `decommissioned` flag to list soft-deleted routers instead.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getRouterById: {
    method: 'GET',
    path: '/routers/:deviceId',
    pathParams: DeviceIdParamSchema,
    responses: { ...authedErrorResponses, 200: RouterSchema, 404: ErrorResponseSchema },
    summary: 'Get router by device ID',
    description: 'Returns a single router-role device by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updateRouter: {
    method: 'PATCH',
    path: '/routers/:deviceId',
    pathParams: DeviceIdParamSchema,
    body: UpdateRouterRequestSchema,
    responses: { ...authedErrorResponses, 200: RouterSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
    summary: 'Update router',
    description: 'Updates the editable fields of a router-role device by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  decommissionRouter: {
    method: 'DELETE',
    path: '/routers/:deviceId',
    pathParams: DeviceIdParamSchema,
    body: z.object({}),
    responses: { ...authedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Decommission router',
    description: 'Decommissions (soft-deletes) a router-role device by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
