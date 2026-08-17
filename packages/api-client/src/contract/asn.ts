import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { AsnListQuerySchema, AsnSchema, CreateAsnRequestSchema, UpdateAsnRequestSchema } from '../schemas/asn';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

const IdParamSchema = z.object({
  id: z.string().uuid(),
});

export const asnRoutes = c.router({
  listAsns: {
    method: 'GET',
    path: '/asns',
    query: AsnListQuerySchema,
    responses: { ...authedErrorResponses, 200: z.array(AsnSchema) },
    summary: 'List ASNs',
    description: 'Returns a list of Autonomous System Numbers, optionally filtered by organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  getAsn: {
    method: 'GET',
    path: '/asns/:id',
    pathParams: IdParamSchema,
    responses: { ...authedErrorResponses, 200: AsnSchema, 404: ErrorResponseSchema },
    summary: 'Get ASN by ID',
    description: 'Returns a single Autonomous System Number by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  createAsn: {
    method: 'POST',
    path: '/asns',
    body: CreateAsnRequestSchema,
    responses: { ...authedErrorResponses, 201: AsnSchema, 400: ErrorResponseSchema },
    summary: 'Create ASN',
    description: 'Creates a new Autonomous System Number.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  updateAsn: {
    method: 'PATCH',
    path: '/asns/:id',
    pathParams: IdParamSchema,
    body: UpdateAsnRequestSchema,
    responses: { ...authedErrorResponses, 200: AsnSchema, 400: ErrorResponseSchema, 404: ErrorResponseSchema },
    summary: 'Update ASN',
    description: 'Updates an existing Autonomous System Number by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  deleteAsn: {
    method: 'DELETE',
    path: '/asns/:id',
    pathParams: IdParamSchema,
    body: z.object({}),
    responses: { ...authedErrorResponses, 204: z.void(), 404: ErrorResponseSchema },
    summary: 'Delete ASN',
    description: 'Deletes an Autonomous System Number by its UUID.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
