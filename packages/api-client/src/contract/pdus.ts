import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { PduListResponseSchema, PduSchema, PdusQuerySchema, UpdatePduRequestSchema } from '../schemas/pdus';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

const DeviceIdParamSchema = z.object({
  deviceId: z.string().uuid(),
});

export const pduRoutes = c.router({
  listPdus: {
    method: 'GET',
    path: '/pdus',
    query: PdusQuerySchema,
    responses: { ...authedErrorResponses, 200: PduListResponseSchema },
    summary: 'List PDUs',
    description:
      'Returns a paginated list of power distribution units. Supports `page`/`pageSize`/`sort`/`search`, a `zoneId` filter, and a `decommissioned` flag to list soft-deleted PDUs instead.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getPduById: {
    method: 'GET',
    path: '/pdus/:deviceId',
    pathParams: DeviceIdParamSchema,
    responses: { ...authedErrorResponses, 200: PduSchema, 404: ErrorResponseSchema },
    summary: 'Get PDU by device ID',
    description: 'Returns a single power distribution unit by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updatePdu: {
    method: 'PATCH',
    path: '/pdus/:deviceId',
    pathParams: DeviceIdParamSchema,
    body: UpdatePduRequestSchema,
    responses: { ...authedErrorResponses, 200: PduSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
    summary: 'Update PDU',
    description: 'Updates the editable fields of a power distribution unit by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  decommissionPdu: {
    method: 'DELETE',
    path: '/pdus/:deviceId',
    pathParams: DeviceIdParamSchema,
    body: z.object({}),
    responses: { ...authedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Decommission PDU',
    description: 'Decommissions (soft-deletes) a power distribution unit by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
