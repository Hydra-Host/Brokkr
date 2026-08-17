import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  CreateIpamPrefixVlanRoleRequestSchema,
  IpamPrefixVlanRoleListQuerySchema,
  IpamPrefixVlanRoleSchema,
  UpdateIpamPrefixVlanRoleRequestSchema,
} from '../schemas/ipam-roles';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses, authedRoleGatedErrorResponses } from './responses';

const c = initContract();
const IdParamSchema = z.object({ id: z.string().uuid() });

export const ipamRolesRoutes = c.router({
  listIpamRoles: {
    method: 'GET',
    path: '/ipam/roles',
    query: IpamPrefixVlanRoleListQuerySchema,
    responses: { ...authedErrorResponses, 200: z.array(IpamPrefixVlanRoleSchema) },
    summary: 'List IPAM roles',
    description: 'Returns a list of IPAM prefix/VLAN roles, optionally filtered by search term.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getIpamRole: {
    method: 'GET',
    path: '/ipam/roles/:id',
    pathParams: IdParamSchema,
    responses: { ...authedErrorResponses, 200: IpamPrefixVlanRoleSchema, 404: ErrorResponseSchema },
    summary: 'Get IPAM role by ID',
    description: 'Returns a single IPAM prefix/VLAN role by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  createIpamRole: {
    method: 'POST',
    path: '/ipam/roles',
    body: CreateIpamPrefixVlanRoleRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      201: IpamPrefixVlanRoleSchema,
      400: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Create IPAM role',
    description: 'Creates a new IPAM prefix/VLAN role definition.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updateIpamRole: {
    method: 'PATCH',
    path: '/ipam/roles/:id',
    pathParams: IdParamSchema,
    body: UpdateIpamPrefixVlanRoleRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: IpamPrefixVlanRoleSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Update IPAM role',
    description: 'Updates an existing IPAM prefix/VLAN role by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  deleteIpamRole: {
    method: 'DELETE',
    path: '/ipam/roles/:id',
    pathParams: IdParamSchema,
    body: z.object({}),
    responses: { ...authedRoleGatedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Delete IPAM role',
    description: 'Deletes an IPAM prefix/VLAN role by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
