import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { PrefixDnsOverrideSchema, ZoneDnsConfigSchema } from '../schemas/dns';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

export const zoneDnsRoutes = c.router({
  getZoneDnsConfig: {
    method: 'GET',
    path: '/zones/:zoneId/dns/config',
    pathParams: z.object({ zoneId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: ZoneDnsConfigSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get zone DNS configuration',
    description:
      'Returns the zone-level DNS configuration that the bridge DNS server uses as its baseline. Per-prefix overrides are read separately.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  updateZoneDnsConfig: {
    method: 'PUT',
    path: '/zones/:zoneId/dns/config',
    pathParams: z.object({ zoneId: z.string() }),
    body: ZoneDnsConfigSchema,
    responses: {
      ...authedErrorResponses,
      200: ZoneDnsConfigSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update zone DNS configuration',
    description: 'Replaces the zone-level DNS configuration and triggers republication of DNS atoms to the bridge.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },
});

export const prefixDnsRoutes = c.router({
  getPrefixDnsOverride: {
    method: 'GET',
    path: '/ipam/prefixes/:id/dns/config',
    pathParams: z.object({ id: z.string().uuid() }),
    responses: {
      ...authedErrorResponses,
      200: PrefixDnsOverrideSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get prefix DNS override',
    description: 'Returns the per-prefix DNS override settings. Fields set to null inherit the zone-level defaults.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  updatePrefixDnsOverride: {
    method: 'PUT',
    path: '/ipam/prefixes/:id/dns/config',
    pathParams: z.object({ id: z.string().uuid() }),
    body: PrefixDnsOverrideSchema,
    responses: {
      ...authedErrorResponses,
      200: PrefixDnsOverrideSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update prefix DNS override',
    description:
      'Replaces the per-prefix DNS override settings and triggers republication of DNS atoms to the bridge. Enabling serveDns requires an IPv4 prefix.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },
});
