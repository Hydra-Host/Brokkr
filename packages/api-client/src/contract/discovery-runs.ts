import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { DiscoveryRunsListResponseSchema, DiscoveryRunsQuerySchema } from '../schemas/discovery-runs';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const discoveryRunsRoutes = c.router({
  listDeviceDiscoveryRuns: {
    method: 'GET',
    path: '/servers/:deviceId/discovery-runs',
    pathParams: z.object({ deviceId: z.string().describe('Device whose discovery runs to list') }),
    query: DiscoveryRunsQuerySchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: DiscoveryRunsListResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'List discovery runs recorded for a device',
    description:
      'Returns the discovery passes recorded for a device, newest first, each with the issues its collectors and composers raised. Read-only; requires the device:read permission and is scoped to the caller organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
