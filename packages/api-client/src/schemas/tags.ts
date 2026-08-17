import { z } from 'zod';

export const TagSchema = z.object({
  id: z.string().uuid().describe('Tag UUID'),
  name: z.string().describe('Tag name'),
  slug: z.string().nullable().describe('URL-safe slug derived from name'),
  color: z.string().nullable().describe('Tag display color (hex or named)'),
  description: z.string().nullable().describe('Tag description'),
  organizationId: z.string().uuid().nullable().describe('Owning organization UUID; null for global/system tags'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type Tag = z.infer<typeof TagSchema>;

export const CreateTagRequestSchema = z.object({
  name: z.string().min(1).describe('Tag name'),
  color: z.string().nullable().optional().describe('Tag display color (hex or named)'),
  description: z.string().trim().nullable().optional().describe('Tag description'),
});
export type CreateTagRequest = z.infer<typeof CreateTagRequestSchema>;

export const UpdateTagRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Tag name'),
  color: z.string().nullable().optional().describe('Tag display color (hex or named)'),
  description: z.string().trim().nullable().optional().describe('Tag description'),
});
export type UpdateTagRequest = z.infer<typeof UpdateTagRequestSchema>;

export const TagListQuerySchema = z.object({
  organizationId: z.string().uuid().optional().describe('Filter by organization UUID'),
});
export type TagListQuery = z.infer<typeof TagListQuerySchema>;
