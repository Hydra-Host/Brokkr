import { z } from 'zod';
import { PaginationQuerySchema } from './pagination';

export const ApiKeySchema = z.object({
  id: z.string().describe('Unique identifier for the API key'),
  name: z.string().nullable().describe('Human-readable name for the API key'),
  start: z.string().nullable().describe('First few characters of the key for identification'),
  prefix: z.string().nullable().describe('Key prefix (e.g. brk_)'),
  userId: z.string().describe('ID of the user who owns this key'),
  organizationId: z.string().nullable().describe('ID of the organization this key is scoped to'),
  role: z
    .string()
    .describe('Role of the key owner, or "Managed role" when the assignment belongs to a private catalog'),
  enabled: z.boolean().describe('Whether the key is currently active'),
  expiresAt: z.coerce.date().nullable().describe('Expiration date, or null if the key does not expire'),
  createdAt: z.coerce.date().describe('When the key was created'),
  updatedAt: z.coerce.date().describe('When the key was last updated'),
  requestCount: z.number().describe('Total number of requests made with this key'),
  remaining: z.number().nullable().describe('Remaining requests allowed, or null if unlimited'),
  lastRequest: z.coerce.date().nullable().describe('Timestamp of the most recent request using this key'),
  metadata: z.string().nullable().describe('JSON metadata associated with the key'),
  permissions: z
    .array(z.string())
    .nullable()
    .describe(
      'Permission keys (resource:action) this key is scoped to. A legacy null scope inherits the owner’s live permissions; malformed non-null scope fails closed; explicit scopes are intersected with the owner’s live permissions.',
    ),
});

export type ApiKey = z.infer<typeof ApiKeySchema>;

export const ApiKeyWithCreatorSchema = ApiKeySchema.extend({
  createdByName: z.string().nullable().describe('Display name of the user who created this key'),
  createdByEmail: z.string().describe('Email address of the user who created this key'),
});

export type ApiKeyWithCreator = z.infer<typeof ApiKeyWithCreatorSchema>;

export const CreatedApiKeySchema = ApiKeyWithCreatorSchema.extend({
  key: z.string().describe('The full API key value. Only returned once at creation time and cannot be retrieved again'),
});

export type CreatedApiKey = z.infer<typeof CreatedApiKeySchema>;

export const ApiKeysQuerySchema = PaginationQuerySchema.extend({
  createdByEmail: z.string().optional().describe('Filter API keys by the email of the user who created them'),
});

export type ApiKeysQuery = z.infer<typeof ApiKeysQuerySchema>;

const MAX_API_KEY_EXPIRES_IN_MILLISECONDS = 10 * 365 * 24 * 60 * 60 * 1000;

export const CreateApiKeyRequestSchema = z.object({
  name: z
    .string()
    .min(1, 'API key name is required')
    .max(32, 'Name must be 32 characters or less')
    .describe('Human-readable API-key name, limited to 32 characters'),
  expiresIn: z
    .number()
    .int()
    .positive()
    .max(MAX_API_KEY_EXPIRES_IN_MILLISECONDS)
    .optional()
    .describe('Time in milliseconds until the key expires, capped at 10 years. Omit for a non-expiring key'),
  permissions: z
    .array(z.string())
    .optional()
    .describe(
      'Permission keys (resource:action) that explicitly restrict this key. Omit or submit an empty array to inherit the owner’s live delegable permissions.',
    ),
});

export type CreateApiKeyRequest = z.infer<typeof CreateApiKeyRequestSchema>;

export const UpdateApiKeyRequestSchema = z.object({
  permissions: z
    .array(z.string())
    .nullable()
    .describe(
      'New explicit permission restriction for the key (resource:action keys). Null or an empty array restores inheritance from the owner’s live delegable permissions.',
    ),
});

export type UpdateApiKeyRequest = z.infer<typeof UpdateApiKeyRequestSchema>;

export const ApiKeyIdParamsSchema = z.object({
  apiKeyId: z.string().describe('Unique identifier of the API key'),
});
