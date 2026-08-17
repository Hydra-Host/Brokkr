import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema, UserSchema } from '../schemas/index';
import { type RouteMetadata } from './metadata';

const c = initContract();

export const appRoutes = c.router({
  getHello: {
    method: 'GET',
    path: '/',
    responses: {
      200: z.string(),
    },
    summary: 'Get hello message',
    description: 'Returns a simple greeting string. Useful as a health check or connectivity test.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getMe: {
    method: 'GET',
    path: '/me',
    responses: {
      200: UserSchema,
      401: ErrorResponseSchema,
    },
    summary: 'Get current authenticated user',
    description: 'Returns the profile of the currently authenticated user based on the session token.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
