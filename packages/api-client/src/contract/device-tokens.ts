import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { DeviceTokenSummarySchema, IssueBrokkrLiveDeviceTokenResponseSchema } from '../schemas/device-tokens';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const deviceTokensRoutes = c.router({
  rotateBrokkrLiveDeviceToken: {
    method: 'POST',
    path: '/devices/me/live-token/rotate',
    body: z.object({}).optional(),
    responses: {
      200: IssueBrokkrLiveDeviceTokenResponseSchema,
      401: ErrorResponseSchema,
    },
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
    summary: 'Rotate Brokkr Live device token',
    description:
      'Issues a new Brokkr Live device token for the authenticated caller, revokes the presented token, republishes live token material to Redis when the device is zone-bound, and returns the new plaintext exactly once.',
  },
  listDeviceTokenSummaries: {
    method: 'GET',
    path: '/servers/:deviceId/device-tokens',
    pathParams: z.object({ deviceId: z.string().uuid().describe('Device whose tokens to list') }),
    responses: { ...authedRoleGatedErrorResponses, 200: z.array(DeviceTokenSummarySchema), 404: ErrorResponseSchema },
    summary: 'List device token status and recency',
    description:
      'Returns each device token with its context, status and last accepted use. Never returns the token or its hash. Requires device-token:access and is scoped to the supplier organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
