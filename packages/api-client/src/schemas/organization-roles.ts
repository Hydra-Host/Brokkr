import { z } from 'zod';

export const PermissionDefinitionSchema = z.object({
  resource: z.string().describe('Resource this permission applies to'),
  action: z.string().describe('Action allowed on the resource'),
  description: z.string().optional().describe('Human-readable description of the permission'),
});
export type PermissionDefinition = z.infer<typeof PermissionDefinitionSchema>;

export const RolePermissionSchema = z.object({
  id: z.string().describe('Unique ID of the role-permission link'),
  permission: PermissionDefinitionSchema.describe('The permission granted'),
});
export type RolePermission = z.infer<typeof RolePermissionSchema>;

export const OrganizationMemberRoleSchema = z.object({
  id: z.string().describe('Unique identifier for the role'),
  name: z.string().describe('Display name of the role'),
  slug: z.string().describe('URL-safe identifier for the role'),
  description: z.string().nullable().optional().describe('Description of what the role provides'),
  isSystem: z.boolean().describe('Whether this is a system-defined role (immutable)'),
  isOwnerCapable: z.boolean().describe('Whether the role contains every permission in the current application catalog'),
  organizationId: z.string().nullable().optional().describe('Organization this role belongs to, null for system roles'),
  templateId: z.string().nullable().optional().describe('ID of the system role this was cloned from'),
  rolePermissions: z.array(RolePermissionSchema).describe('Permissions granted by this role'),
  _count: z
    .object({
      members: z.number().describe('Number of active members assigned to this role'),
      invitations: z.number().describe('Number of pending unexpired invitations assigned to this role'),
    })
    .describe('Aggregate counts'),
  createdAt: z.coerce.date().describe('When the role was created'),
  updatedAt: z.coerce.date().describe('When the role was last updated'),
});
export type OrganizationMemberRole = z.infer<typeof OrganizationMemberRoleSchema>;

export const CreateCustomRoleRequestSchema = z.object({
  name: z.string().min(1).max(50).describe('Display name for the custom role'),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .describe('URL-safe identifier'),
  description: z.string().max(200).optional().describe('Description of the role'),
  permissions: z.array(z.string()).min(1).describe('Permission keys (resource:action) to grant'),
  templateId: z.string().optional().describe('ID of a system role to base this on'),
});
export type CreateCustomRoleRequest = z.infer<typeof CreateCustomRoleRequestSchema>;

export const CloneSystemRoleRequestSchema = z.object({
  systemRoleId: z.string().describe('ID of the system role to clone'),
  name: z.string().min(1).max(50).describe('Name for the new custom role'),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with hyphens')
    .describe('URL-safe identifier for the new role'),
});
export type CloneSystemRoleRequest = z.infer<typeof CloneSystemRoleRequestSchema>;

export const UpdateRolePermissionsRequestSchema = z.object({
  permissions: z.array(z.string()).min(1).describe('New complete set of permission keys for the role'),
});
export type UpdateRolePermissionsRequest = z.infer<typeof UpdateRolePermissionsRequestSchema>;

export const AssignRoleRequestSchema = z.object({
  roleId: z.string().describe('ID of the role to assign'),
});
export type AssignRoleRequest = z.infer<typeof AssignRoleRequestSchema>;

export const GrantOwnerAccessRequestSchema = z.object({
  roleId: z.string().min(1).describe('Non-empty ID of the owner-capable role to assign to the member'),
});
export type GrantOwnerAccessRequest = z.infer<typeof GrantOwnerAccessRequestSchema>;

export const RevokeOwnerAccessRequestSchema = z.object({
  replacementRoleId: z
    .string()
    .min(1)
    .describe('Non-empty ID of the non-owner role to assign after owner access is removed'),
});
export type RevokeOwnerAccessRequest = z.infer<typeof RevokeOwnerAccessRequestSchema>;

export const TransferOwnershipRequestSchema = z.object({
  sourceMemberId: z.string().min(1).describe('Non-empty ID of the current owner member to demote'),
  recipientMemberId: z.string().min(1).describe('Non-empty ID of the member who will receive owner access'),
  ownerRoleId: z.string().min(1).describe('Non-empty ID of the owner-capable role to assign to the recipient'),
  sourceReplacementRoleId: z
    .string()
    .min(1)
    .describe('Non-empty ID of the non-owner role to assign to the source member'),
});
export type TransferOwnershipRequest = z.infer<typeof TransferOwnershipRequestSchema>;
