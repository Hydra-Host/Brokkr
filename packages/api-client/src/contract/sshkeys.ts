import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/index';
import { createPaginatedResponseSchema, PaginationQuerySchema } from '../schemas/pagination';
import { CreateSshKeyRequestSchema, SshKeySchema, SshKeyWithUserSchema } from '../schemas/sshkeys';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

export const sshkeysRoutes = c.router({
  getSshKeys: {
    method: 'GET',
    path: '/sshkeys',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(SshKeySchema),
    },
    summary: 'Get all SSH keys for authenticated user',
    description:
      'Returns a paginated list of SSH keys belonging to the authenticated user. These keys can be selected during device provisioning.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getOrganizationSshKeys: {
    method: 'GET',
    path: '/sshkeys/organization',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(SshKeyWithUserSchema),
      404: ErrorResponseSchema,
    },
    summary: 'Get all SSH keys for organization',
    description:
      'Returns a paginated list of all SSH keys across all members of the current organization, including user details for each key.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getSshKey: {
    method: 'GET',
    path: '/sshkeys/:id',
    pathParams: z.object({ id: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: SshKeySchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get specific SSH key by ID',
    description: 'Returns the full details of a single SSH key by its unique identifier.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  createSshKey: {
    method: 'POST',
    path: '/sshkeys',
    body: CreateSshKeyRequestSchema,
    responses: {
      ...authedErrorResponses,
      201: SshKeySchema,
      400: ErrorResponseSchema,
    },
    summary: 'Create new SSH key',
    description:
      'Registers a new SSH public key for the authenticated user. The key is validated and its fingerprint is computed on the server.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  deleteSshKey: {
    method: 'DELETE',
    path: '/sshkeys/:id',
    pathParams: z.object({ id: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: SshKeySchema,
      404: ErrorResponseSchema,
    },
    summary: 'Delete SSH key',
    description:
      'Soft-deletes an SSH key by setting its deletion timestamp. The key will no longer be available for new provisioning operations.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
