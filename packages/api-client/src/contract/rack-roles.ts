import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  CreateDcimRackRoleRequestSchema,
  DcimRackRoleListQuerySchema,
  DcimRackRoleSchema,
  UpdateDcimRackRoleRequestSchema,
} from '../schemas/rack-roles';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();
const IdParamSchema = z.object({ id: z.string().uuid() });

export const rackRolesRoutes = c.router({
  listDcimRackRoles: {
    method: 'GET',
    path: '/dcim/rack-roles',
    query: DcimRackRoleListQuerySchema,
    responses: { ...authedErrorResponses, 200: z.array(DcimRackRoleSchema) },
    summary: 'List rack roles',
    description: 'Returns a list of rack roles, optionally filtered by search term.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getDcimRackRole: {
    method: 'GET',
    path: '/dcim/rack-roles/:id',
    pathParams: IdParamSchema,
    responses: { ...authedErrorResponses, 200: DcimRackRoleSchema, 404: ErrorResponseSchema },
    summary: 'Get rack role by ID',
    description: 'Returns a single rack role by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  createDcimRackRole: {
    method: 'POST',
    path: '/dcim/rack-roles',
    body: CreateDcimRackRoleRequestSchema,
    responses: { ...authedErrorResponses, 201: DcimRackRoleSchema, 400: ErrorResponseSchema },
    summary: 'Create rack role',
    description: 'Creates a new rack role definition.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updateDcimRackRole: {
    method: 'PATCH',
    path: '/dcim/rack-roles/:id',
    pathParams: IdParamSchema,
    body: UpdateDcimRackRoleRequestSchema,
    responses: { ...authedErrorResponses, 200: DcimRackRoleSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
    summary: 'Update rack role',
    description: 'Updates an existing rack role by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  deleteDcimRackRole: {
    method: 'DELETE',
    path: '/dcim/rack-roles/:id',
    pathParams: IdParamSchema,
    body: z.object({}),
    responses: { ...authedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Delete rack role',
    description: 'Deletes a rack role by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
