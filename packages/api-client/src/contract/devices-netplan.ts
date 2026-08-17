import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { DeviceNetplanQuerySchema, DeviceNetplanResponseSchema } from '../schemas/devices-netplan';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';

const c = initContract();

export const devicesNetplanRoutes = c.router({
  getDeviceNetplan: {
    method: 'GET',
    path: '/devices/:deviceId/netplan',
    pathParams: z.object({
      deviceId: z.string().uuid().describe('UUID of the device to render netplan for.'),
    }),
    query: DeviceNetplanQuerySchema,
    responses: {
      200: DeviceNetplanResponseSchema,
      401: ErrorResponseSchema,
      403: ErrorResponseSchema,
      404: ErrorResponseSchema,
      422: ErrorResponseSchema,
    },
    summary: 'Get rendered netplan YAML for a device',
    description:
      "Renders the device's netplan configuration in-process from the typed DeviceContext and returns non-empty YAML. The `phase` query parameter selects between the in-rescue/discovery network config (`live`) and the post-provision target-OS network config (`deploy`); incomplete networking context returns 422.",
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
