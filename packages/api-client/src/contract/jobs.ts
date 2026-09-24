import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/index';
import {
  LifecycleJobEventsResponseSchema,
  LifecycleJobSummarySchema,
  ListLifecycleJobsQuerySchema,
} from '../schemas/jobs';
import { createPaginatedResponseSchema } from '../schemas/pagination';
import { type RouteMetadata } from './metadata';
import { authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const jobsRoutes = c.router({
  listLifecycleJobs: {
    method: 'GET',
    path: '/jobs',
    query: ListLifecycleJobsQuerySchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: createPaginatedResponseSchema(LifecycleJobSummarySchema),
      400: ErrorResponseSchema,
    },
    summary: 'List lifecycle jobs for a device or deployment',
    description:
      'Returns a paginated history of lifecycle jobs (provision, reprovision, power, deprovision) for a device or deployment. Restricted to the instance operator; requires job:read.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
  listLifecycleJobEvents: {
    method: 'GET',
    path: '/jobs/:jobId/events',
    pathParams: z.object({
      jobId: z.string().uuid().describe('Lifecycle job id; equals the plan_id the bridge reports on'),
    }),
    responses: { ...authedRoleGatedErrorResponses, 200: LifecycleJobEventsResponseSchema, 404: ErrorResponseSchema },
    summary: 'List the step events recorded for one lifecycle job',
    description:
      'Returns the saga step events the bridge reported for one job, oldest first, capped at 500 with a truncated flag. Restricted to the instance operator; requires job:read.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
