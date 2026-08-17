import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/responses';
import {
  SwitchListResponseSchema,
  SwitchSchema,
  SwitchesQuerySchema,
  UpdateSwitchRequestSchema,
} from '../schemas/switches';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

const DeviceIdParamSchema = z.object({
  deviceId: z.string().uuid(),
});

export const switchRoutes = c.router({
  listSwitches: {
    method: 'GET',
    path: '/switches',
    query: SwitchesQuerySchema,
    responses: { ...authedErrorResponses, 200: SwitchListResponseSchema },
    summary: 'List switches',
    description:
      'Returns a paginated list of switch-role devices. Supports `page`/`pageSize`/`sort`/`search`, a `zoneId` filter, and a `decommissioned` flag to list soft-deleted switches instead.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getSwitchById: {
    method: 'GET',
    path: '/switches/:deviceId',
    pathParams: DeviceIdParamSchema,
    responses: { ...authedErrorResponses, 200: SwitchSchema, 404: ErrorResponseSchema },
    summary: 'Get switch by device ID',
    description: 'Returns a single switch-role device by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updateSwitch: {
    method: 'PATCH',
    path: '/switches/:deviceId',
    pathParams: DeviceIdParamSchema,
    body: UpdateSwitchRequestSchema,
    responses: { ...authedErrorResponses, 200: SwitchSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
    summary: 'Update switch',
    description: 'Updates the editable fields of a switch-role device by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  decommissionSwitch: {
    method: 'DELETE',
    path: '/switches/:deviceId',
    pathParams: DeviceIdParamSchema,
    body: z.object({}),
    responses: { ...authedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Decommission switch',
    description: 'Decommissions (soft-deletes) a switch-role device by its Device UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
