import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';

const c = initContract();

export const pluginsRoutes = c.router({
  getEnabledPlugins: {
    method: 'GET',
    path: '/plugins/enabled',
    responses: {
      200: z.object({
        pluginIds: z.array(z.string()),
      }),
    },
    summary: 'List enabled plugin IDs',
    description:
      'Returns the IDs of plugins enabled on the server, the single source of truth the frontend uses to mount only the matching plugin UIs.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getPluginHostContext: {
    method: 'GET',
    path: '/plugins/host-context',
    responses: {
      200: z.object({
        isInstanceOperator: z.boolean().describe("Whether the caller's active organization is the instance operator."),
      }),
      401: ErrorResponseSchema,
    },
    summary: 'Plugin host context for the current caller',
    description:
      'Per-caller context the frontend plugin host needs to decide which plugins to mount — e.g. operator-only plugins mount only when isInstanceOperator is true. Authenticated.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
