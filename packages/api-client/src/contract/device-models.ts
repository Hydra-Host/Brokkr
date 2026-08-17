import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  CreateDeviceModelRequestSchema,
  DeviceModelListQuerySchema,
  DeviceModelSchema,
  UpdateDeviceModelRequestSchema,
} from '../schemas/device-models';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export const deviceModelsRoutes = c.router({
  listDeviceModels: {
    method: 'GET',
    path: '/device-models',
    query: DeviceModelListQuerySchema,
    responses: { ...authedErrorResponses, 200: z.array(DeviceModelSchema) },
    summary: 'List device models',
    description: 'Returns a list of device models, optionally filtered by manufacturer.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getDeviceModel: {
    method: 'GET',
    path: '/device-models/:id',
    pathParams: IdParamSchema,
    responses: { ...authedErrorResponses, 200: DeviceModelSchema, 404: ErrorResponseSchema },
    summary: 'Get device model by ID',
    description: 'Returns a single device model by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  createDeviceModel: {
    method: 'POST',
    path: '/device-models',
    body: CreateDeviceModelRequestSchema,
    responses: { ...authedErrorResponses, 201: DeviceModelSchema, 400: ErrorResponseSchema },
    summary: 'Create device model',
    description: 'Creates a new device model definition.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updateDeviceModel: {
    method: 'PATCH',
    path: '/device-models/:id',
    pathParams: IdParamSchema,
    body: UpdateDeviceModelRequestSchema,
    responses: { ...authedErrorResponses, 200: DeviceModelSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
    summary: 'Update device model',
    description: 'Updates an existing device model by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  deleteDeviceModel: {
    method: 'DELETE',
    path: '/device-models/:id',
    pathParams: IdParamSchema,
    body: z.object({}),
    responses: { ...authedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Delete device model',
    description: 'Deletes a device model by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
