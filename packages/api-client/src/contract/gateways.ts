import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  CreateGatewayRequestSchema,
  GatewayListQuerySchema,
  GatewaySchema,
  UpdateGatewayRequestSchema,
} from '../schemas/gateways';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();
const IdParamSchema = z.object({ id: z.string().uuid() });

export const gatewaysRoutes = c.router({
  listGateways: {
    method: 'GET',
    path: '/ipam/gateways',
    query: GatewayListQuerySchema,
    responses: { ...authedErrorResponses, 200: z.array(GatewaySchema) },
    summary: 'List gateways',
    description: 'Returns a list of gateways, optionally filtered by prefix or VRF.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getGateway: {
    method: 'GET',
    path: '/ipam/gateways/:id',
    pathParams: IdParamSchema,
    responses: { ...authedErrorResponses, 200: GatewaySchema, 404: ErrorResponseSchema },
    summary: 'Get gateway by ID',
    description: 'Returns a single gateway by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  createGateway: {
    method: 'POST',
    path: '/ipam/gateways',
    body: CreateGatewayRequestSchema,
    responses: { ...authedErrorResponses, 201: GatewaySchema, 400: ErrorResponseSchema },
    summary: 'Create gateway',
    description: 'Creates a new gateway record.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updateGateway: {
    method: 'PATCH',
    path: '/ipam/gateways/:id',
    pathParams: IdParamSchema,
    body: UpdateGatewayRequestSchema,
    responses: { ...authedErrorResponses, 200: GatewaySchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
    summary: 'Update gateway',
    description: 'Updates an existing gateway by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  deleteGateway: {
    method: 'DELETE',
    path: '/ipam/gateways/:id',
    pathParams: IdParamSchema,
    body: z.object({}),
    responses: { ...authedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Delete gateway',
    description: 'Deletes a gateway by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
