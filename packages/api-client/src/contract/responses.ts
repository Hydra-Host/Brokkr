import { ErrorResponseSchema } from '../schemas/responses';

/** Spread into every route behind UnifiedIdentityGuard; genuinely @Public() routes must NOT spread these. */
export const authedErrorResponses = {
  401: ErrorResponseSchema,
} as const;

export const authedRoleGatedErrorResponses = {
  401: ErrorResponseSchema,
  403: ErrorResponseSchema,
} as const;
