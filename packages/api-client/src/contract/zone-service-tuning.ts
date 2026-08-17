import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/responses';
import { ZoneServiceTuningSchema } from '../schemas/zone-service-tuning';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

export const zoneServiceTuningRoutes = c.router({
  getZoneServiceTuning: {
    method: 'GET',
    path: '/zones/:zoneId/service-tuning',
    pathParams: z.object({ zoneId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: ZoneServiceTuningSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get zone bridge-service tuning',
    description:
      'Returns the zone-level runtime tuning for the bridge DHCP engine and VRRP failover, delivered to bridges via Redis config atoms.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  updateZoneServiceTuning: {
    method: 'PUT',
    path: '/zones/:zoneId/service-tuning',
    pathParams: z.object({ zoneId: z.string() }),
    body: ZoneServiceTuningSchema,
    responses: {
      ...authedErrorResponses,
      200: ZoneServiceTuningSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update zone bridge-service tuning',
    description:
      'Replaces the zone-level DHCP/VRRP runtime tuning and republishes the affected config atoms to the bridges.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },
});
