import { z } from 'zod';
import { BooleanQueryParamSchema } from './common';
import { PaginationQuerySchema } from './pagination';

export const OrganizationMembershipRoleSchema = z
  .enum(['Admin', 'Member', 'Owner'])
  .describe('Role a user can hold within an organization');

export type OrganizationMembershipRole = z.infer<typeof OrganizationMembershipRoleSchema>;

export const OrganizationMemberRoleSummarySchema = z.object({
  id: z.string().describe('ID of the OrganizationMemberRole row assigned to this member'),
  name: z.string().describe('Display name of the role (e.g. "Owner", "Admin", or a custom role name)'),
  slug: z.string().describe('URL-safe slug of the role'),
});

export type OrganizationMemberRoleSummary = z.infer<typeof OrganizationMemberRoleSummarySchema>;

export const OrganizationMemberSchema = z.object({
  id: z.string().describe('Unique identifier for the membership record'),
  userId: z.string().describe('ID of the member user'),
  organizationId: z.string().describe('ID of the organization'),
  role: z
    .string()
    .describe(
      'Member role display name, or "Managed role" when the assignment belongs to a private application catalog.',
    ),
  assignedRoleId: z
    .string()
    .nullable()
    .describe(
      'ID of the assigned OrganizationMemberRole, or null when unassigned or private to another application catalog.',
    ),
  createdAt: z.coerce.date().describe('When the membership was created'),
  updatedAt: z.coerce.date().describe('When the membership was last updated'),
  deletedAt: z.coerce.date().nullable().describe('When the membership was soft-deleted, or null if active'),
});

export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;

export const PublicOrganizationMemberUserSchema = z
  .object({
    id: z.string().describe('Unique identifier for the user'),
    email: z.string().email().describe('Email address of the user'),
    name: z.string().nullable().describe('Display name of the user'),
    image: z.string().nullable().describe('URL to the user profile image'),
  })
  .describe('Minimal public profile of a co-member, omitting internal account and moderation state');

export const OrganizationMemberWithUserSchema = OrganizationMemberSchema.extend({
  user: PublicOrganizationMemberUserSchema.describe('Public user details for this membership'),
});

export type OrganizationMemberWithUser = z.infer<typeof OrganizationMemberWithUserSchema>;

export const OrganizationMembersQuerySchema = PaginationQuerySchema.extend({
  role: OrganizationMembershipRoleSchema.optional().describe(
    'Filter members by legacy role enum. Kept for back-compat — prefer `assignedRoleId` for the new RBAC-driven filter.',
  ),
  assignedRoleId: z
    .string()
    .optional()
    .describe(
      'Filter members by assigned OrganizationMemberRole id. Use this to filter against the dynamic role list returned by `listOrganizationRoles`.',
    ),
  ownerTransferEligible: BooleanQueryParamSchema.optional().describe(
    'Return only active, unbanned members with an assigned non-owner role who can receive ownership through the transfer flow.',
  ),
  excludeMemberId: z
    .string()
    .min(1)
    .optional()
    .describe('Exclude one membership ID from the result, such as the current owner during ownership transfer.'),
});

export type OrganizationMembersQuery = z.infer<typeof OrganizationMembersQuerySchema>;

export const UpdateOrganizationMemberRoleRequestSchema = z.object({
  role: OrganizationMembershipRoleSchema.describe('New role to assign to the member'),
});

export type UpdateOrganizationMemberRoleRequest = z.infer<typeof UpdateOrganizationMemberRoleRequestSchema>;
