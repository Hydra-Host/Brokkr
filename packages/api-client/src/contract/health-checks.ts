import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  DeviceHealthChecksListResponseSchema,
  DeviceHealthSummarySchema,
  RequestDeviceHealthCheckResponseSchema,
} from '../schemas/health-checks';
import { PaginationQuerySchema } from '../schemas/pagination';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const healthChecksRoutes = c.router({
  listDeviceHealthChecks: {
    method: 'GET',
    path: '/servers/:deviceId/health-checks',
    pathParams: z.object({ deviceId: z.string().uuid().describe('Device whose health checks to list') }),
    query: PaginationQuerySchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: DeviceHealthChecksListResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'List recorded health check changes for a device',
    description:
      'Returns the bridge health check rows for a device, newest first. The bridge records a row only when a check result changed, and rows older than 7 days are deleted. Requires device:read and is scoped to the supplier organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getDeviceHealthSummary: {
    method: 'GET',
    path: '/servers/:deviceId/health',
    pathParams: z.object({ deviceId: z.string().uuid().describe('Device to summarize') }),
    responses: { ...authedRoleGatedErrorResponses, 200: DeviceHealthSummarySchema, 404: ErrorResponseSchema },
    summary: 'Latest health snapshot for a device',
    description:
      'Reads the bridge health snapshot for the device and falls back to the newest recorded change. States when no check is known. The supplier gets every field; the renting customer gets power and primary reachability only.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  requestDeviceHealthCheck: {
    method: 'POST',
    path: '/servers/:deviceId/health-checks',
    pathParams: z.object({ deviceId: z.string().uuid().describe('Device to check') }),
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: RequestDeviceHealthCheckResponseSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
      429: ErrorResponseSchema,
    },
    summary: 'Run a health check now',
    description:
      'Enqueues the bridge device_health_check saga for the device. A new history row appears only if a result changed. Requires device:health-check. Refused with 409 while the last known credential check failed, and with 429 inside the scheduled interval.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
