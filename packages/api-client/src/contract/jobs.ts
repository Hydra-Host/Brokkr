import { initContract } from '@ts-rest/core';
import { ErrorResponseSchema } from '../schemas/index';
import { LifecycleJobSummarySchema, ListLifecycleJobsQuerySchema } from '../schemas/jobs';
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
});
