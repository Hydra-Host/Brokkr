import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  CreateDeploymentProjectRequestSchema,
  DeploymentProjectSchema,
  MoveDeploymentsToProjectRequestSchema,
  UpdateDeploymentProjectRequestSchema,
} from '../schemas/deployments-projects';
import { ErrorResponseSchema } from '../schemas/index';
import { createPaginatedResponseSchema, PaginationQuerySchema } from '../schemas/pagination';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

export const deploymentsProjectsRoutes = c.router({
  createDeploymentProject: {
    method: 'POST',
    path: '/deployments/projects',
    body: CreateDeploymentProjectRequestSchema,
    responses: {
      ...authedErrorResponses,
      201: DeploymentProjectSchema,
      400: ErrorResponseSchema,
    },
    summary: 'Create a new project',
    description:
      'Creates a new deployment project for the current organization. Projects are used to group related deployments.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getDeploymentProjects: {
    method: 'GET',
    path: '/deployments/projects',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(DeploymentProjectSchema),
    },
    summary: 'Get all projects for an organization',
    description:
      'Returns a paginated list of all deployment projects belonging to the current organization, including their associated deployments.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getDeploymentProjectById: {
    method: 'GET',
    path: '/deployments/projects/:projectId',
    pathParams: z.object({ projectId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: DeploymentProjectSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get a project by ID',
    description: 'Returns full details for a single deployment project, including all deployments assigned to it.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateDeploymentProject: {
    method: 'PATCH',
    path: '/deployments/projects/:projectId',
    pathParams: z.object({ projectId: z.string() }),
    body: UpdateDeploymentProjectRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: DeploymentProjectSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update a deployment project',
    description:
      'Updates the name and default status of a deployment project. Setting isDefault to true makes this the default project for new deployments.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  deleteDeploymentProject: {
    method: 'DELETE',
    path: '/deployments/projects/:projectId',
    pathParams: z.object({ projectId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: DeploymentProjectSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Delete a project',
    description:
      'Deletes a deployment project. The project must not be the default project and all deployments must be moved out first.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  moveDeploymentsToProject: {
    method: 'PUT',
    path: '/deployments/projects/:projectId/deployments',
    pathParams: z.object({ projectId: z.string() }),
    body: MoveDeploymentsToProjectRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(DeploymentProjectSchema),
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Move deployments from one project to another',
    description: 'Moves one or more deployments from a source project to the target project specified in the URL path.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
