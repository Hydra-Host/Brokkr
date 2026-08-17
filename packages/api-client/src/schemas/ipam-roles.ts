import { z } from 'zod';

export const IpamPrefixVlanRoleSchema = z.object({
  id: z.string().uuid().describe('IPAM prefix/VLAN role UUID'),
  name: z.string().describe('Role name'),
  slug: z.string().describe('Role slug'),
  weight: z.number().int().describe('Role weight for ordering'),
  description: z.string().nullable().describe('Role description'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type IpamPrefixVlanRole = z.infer<typeof IpamPrefixVlanRoleSchema>;

export const CreateIpamPrefixVlanRoleRequestSchema = z.object({
  name: z.string().min(1).describe('Role name'),
  slug: z.string().min(1).describe('Role slug'),
  weight: z.number().int().optional().default(1000).describe('Role weight for ordering'),
  description: z.string().trim().optional().describe('Role description'),
});
export type CreateIpamPrefixVlanRoleRequest = z.infer<typeof CreateIpamPrefixVlanRoleRequestSchema>;

export const UpdateIpamPrefixVlanRoleRequestSchema = z.object({
  name: z.string().min(1).optional().describe('Role name'),
  slug: z.string().min(1).optional().describe('Role slug'),
  weight: z.number().int().optional().describe('Role weight for ordering'),
  description: z.string().trim().nullable().optional().describe('Role description'),
});
export type UpdateIpamPrefixVlanRoleRequest = z.infer<typeof UpdateIpamPrefixVlanRoleRequestSchema>;

export const IpamPrefixVlanRoleListQuerySchema = z.object({
  search: z.string().trim().optional().describe('Search by role name'),
});
export type IpamPrefixVlanRoleListQuery = z.infer<typeof IpamPrefixVlanRoleListQuerySchema>;
