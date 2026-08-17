import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { RegionResponseSchema } from '../schemas/regions';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

export const regionsRoutes = c.router({
  listRegions: {
    method: 'GET',
    path: '/regions',
    responses: {
      ...authedErrorResponses,
      200: z.array(RegionResponseSchema),
    },
    summary: 'List geographic regions',
    description:
      "Returns the marketplace geographic regions, including each region's boundary (GeoJSON MultiPolygon) for map rendering. Zones and their devices are assigned to a region by point-in-polygon of the zone's primary-address coordinates.",
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
