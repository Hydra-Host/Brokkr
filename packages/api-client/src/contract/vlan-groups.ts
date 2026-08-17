import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/responses';
import {
  CreateVlanGroupRequestSchema,
  UpdateVlanGroupRequestSchema,
  VlanGroupListQuerySchema,
  VlanGroupSchema,
} from '../schemas/vlan-groups';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export const vlanGroupsRoutes = c.router({
  listVlanGroups: {
    method: 'GET',
    path: '/ipam/vlan-groups',
    query: VlanGroupListQuerySchema,
    responses: { ...authedErrorResponses, 200: z.array(VlanGroupSchema) },
    summary: 'List VLAN groups',
    description: 'Returns a list of VLAN groups, optionally filtered by zone.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getVlanGroup: {
    method: 'GET',
    path: '/ipam/vlan-groups/:id',
    pathParams: IdParamSchema,
    responses: { ...authedErrorResponses, 200: VlanGroupSchema, 404: ErrorResponseSchema },
    summary: 'Get VLAN group by ID',
    description: 'Returns a single VLAN group by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  createVlanGroup: {
    method: 'POST',
    path: '/ipam/vlan-groups',
    body: CreateVlanGroupRequestSchema,
    responses: { ...authedErrorResponses, 201: VlanGroupSchema, 400: ErrorResponseSchema },
    summary: 'Create VLAN group',
    description: 'Creates a new VLAN group for scoping VLAN ID ranges.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updateVlanGroup: {
    method: 'PATCH',
    path: '/ipam/vlan-groups/:id',
    pathParams: IdParamSchema,
    body: UpdateVlanGroupRequestSchema,
    responses: { ...authedErrorResponses, 200: VlanGroupSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
    summary: 'Update VLAN group',
    description: 'Updates an existing VLAN group by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  deleteVlanGroup: {
    method: 'DELETE',
    path: '/ipam/vlan-groups/:id',
    pathParams: IdParamSchema,
    body: z.object({}),
    responses: { ...authedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Delete VLAN group',
    description: 'Deletes a VLAN group by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
