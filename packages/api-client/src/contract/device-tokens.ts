import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { IssueBrokkrLiveDeviceTokenResponseSchema } from '../schemas/device-tokens';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';

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
});
