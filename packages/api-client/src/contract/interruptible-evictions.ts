import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/index';
import {
  InterruptibleEvictionActionResponseSchema,
  PendingInterruptibleEvictionSchema,
} from '../schemas/interruptible-evictions';
import { type RouteMetadata } from './metadata';
import { authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const interruptibleEvictionsRoutes = c.router({
  listPendingInterruptibleEvictions: {
    method: 'GET',
    path: '/admin/interruptible-evictions',
    responses: {
      ...authedRoleGatedErrorResponses,
      200: z.array(PendingInterruptibleEvictionSchema),
    },
    summary: 'List pending interruptible evictions',
    description:
      'Returns all interruptible-eviction approval requests still pending platform-admin review. Restricted to members of the Hydrahost platform organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  authorizeInterruptibleEviction: {
    method: 'PATCH',
    path: '/admin/interruptible-evictions/:requestId/authorize',
    pathParams: z.object({
      requestId: z.string().describe('ID of the pending interruptible-eviction request to authorize.'),
    }),
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: InterruptibleEvictionActionResponseSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Authorize a pending interruptible eviction',
    description:
      'Platform admin authorizes a pending interruptible eviction, immediately arming the outgoing eviction and parking the incoming provision. Marks the request EXECUTED. Restricted to the Hydrahost platform organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  rejectInterruptibleEviction: {
    method: 'PATCH',
    path: '/admin/interruptible-evictions/:requestId/reject',
    pathParams: z.object({
      requestId: z.string().describe('ID of the pending interruptible-eviction request to reject.'),
    }),
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: InterruptibleEvictionActionResponseSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Reject a pending interruptible eviction',
    description:
      'Platform admin rejects a pending interruptible eviction. No eviction or provision is created; the request is marked REJECTED. Restricted to the Hydrahost platform organization.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
