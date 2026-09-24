import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { DeviceBootReadinessSchema } from '../schemas/boot-readiness';
import { DeviceBootTrailSchema } from '../schemas/boot-trail';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const bootTrailRoutes = c.router({
  getDeviceBootTrail: {
    method: 'GET',
    path: '/servers/:deviceId/boot-trail',
    pathParams: z.object({ deviceId: z.string().uuid().describe('Device to read the boot trail for') }),
    responses: { ...authedRoleGatedErrorResponses, 200: DeviceBootTrailSchema, 404: ErrorResponseSchema },
    summary: 'Read the PXE and iPXE trail for a device',
    description:
      'Returns the last proxy-DHCP decision and the last iPXE chain hit the zone bridge recorded for the device PXE MAC. Read-only; requires device:read and is scoped to the supplier organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getDeviceBootReadiness: {
    method: 'GET',
    path: '/servers/:deviceId/boot-readiness',
    pathParams: z.object({ deviceId: z.string().uuid().describe('Device to evaluate') }),
    responses: { ...authedRoleGatedErrorResponses, 200: DeviceBootReadinessSchema, 404: ErrorResponseSchema },
    summary: 'Evaluate PXE boot readiness for a device',
    description:
      'Composes the hub prefix DHCP checks and the bridge boot trail into one finding list for the device. Read-only; requires device:read and ipam:read.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
