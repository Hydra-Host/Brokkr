import { z } from 'zod';

export const DcimRackRoleSchema = z.object({
  id: z.string().uuid().describe('Rack role UUID'),
  name: z.string().describe('Rack role name'),
  slug: z.string().describe('Rack role slug'),
  color: z.string().nullable().describe('Rack role display color (hex or named)'),
  description: z.string().nullable().describe('Rack role description'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type DcimRackRole = z.infer<typeof DcimRackRoleSchema>;

export const CreateDcimRackRoleRequestSchema = z.object({
  name: z.string().min(1).describe('Rack role name'),
  slug: z.string().min(1).describe('Rack role slug'),
  color: z.string().trim().optional().describe('Rack role display color (hex or named)'),
  description: z.string().trim().optional().describe('Rack role description'),
});
export type CreateDcimRackRoleRequest = z.infer<typeof CreateDcimRackRoleRequestSchema>;

export const UpdateDcimRackRoleRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Rack role name'),
  slug: z.string().min(1).optional().describe('Rack role slug'),
  color: z.string().trim().nullable().optional().describe('Rack role display color (hex or named)'),
  description: z.string().trim().nullable().optional().describe('Rack role description'),
});
export type UpdateDcimRackRoleRequest = z.infer<typeof UpdateDcimRackRoleRequestSchema>;

export const DcimRackRoleListQuerySchema = z.object({
  search: z.string().trim().optional().describe('Search by rack role name'),
});
export type DcimRackRoleListQuery = z.infer<typeof DcimRackRoleListQuerySchema>;
