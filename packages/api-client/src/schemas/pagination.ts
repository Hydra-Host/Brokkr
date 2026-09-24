import { z } from 'zod';

export const PaginationQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(1_000_000_000)
    .optional()
    .default(1)
    .describe('Page number (1-indexed). Capped so (page-1)*pageSize cannot overflow the SQL OFFSET.'),
  pageSize: z.coerce.number().int().min(1).max(100).optional().describe('Number of items per page (max 100)'),
  sort: z
    .string()
    .optional()
    .describe(
      'Comma-delimited sort expression "field:dir,field:dir"; dir is "asc" (default) or "desc". Unknown fields are dropped.',
    ),
  search: z
    .string()
    .max(200)
    .optional()
    .describe(
      'Free-text query (max 200 chars). Case-insensitive substring match across a resource-specific set of searchable fields.',
    ),
  filters: z
    .string()
    .optional()
    .describe(
      'Pipe-delimited filter expression "field:op:value|field:op:value". Operators: eq, neq, gt, gte, lt, lte, contains. Repeating the same field with eq OR-combines values; different fields AND together. Unknown fields and invalid values are silently dropped.',
    ),
});

export type PaginationQuery = z.infer<typeof PaginationQuerySchema>;

export const PaginationMetaSchema = z.object({
  page: z.number().describe('Current page number'),
  pageSize: z.number().describe('Number of items returned per page'),
  totalItems: z.number().describe('Total number of items matching the query'),
  totalPages: z.number().describe('Total number of pages available'),
});

export type PaginationMeta = z.infer<typeof PaginationMetaSchema>;

export function createPaginatedResponseSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema).describe('Array of items for the current page'),
    meta: PaginationMetaSchema.describe('Pagination metadata'),
  });
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}
