import { TenantType } from '@repo/database/enums';
import { z } from 'zod';
import { zodEnumFromPrisma } from './prisma-enum';

export const TenantTypeSchema = zodEnumFromPrisma(TenantType).describe(
  'Type of tenant: demand-side or supply-side customer',
);
export type { TenantType };

export const OrganizationSchema = z.object({
  id: z.string().describe('Unique identifier for the organization'),
  name: z.string().describe('Display name of the organization'),
  tenantType: TenantTypeSchema.describe('Whether the organization is a demand or supply customer'),
  logo: z.string().nullable().describe('URL to the organization logo image'),
  metadata: z.string().nullable().describe('JSON-encoded metadata for the organization'),
  email: z.string().nullable().optional().describe('Contact email for the organization'),
  country: z.string().nullable().optional().describe('Country where the organization is based'),
  createdAt: z.coerce.date().describe('When the organization was created'),
  updatedAt: z.coerce.date().nullable().describe('When the organization was last updated'),
});

export type Organization = z.infer<typeof OrganizationSchema>;

export const CreateOrganizationRequestSchema = z.object({
  name: z
    .string()
    .min(1, 'Organization name is required')
    .max(100, 'Organization name must be less than 100 characters')
    .describe('Name for the new organization (1–100 characters)'),
  type: TenantTypeSchema.describe('Tenant type for the new organization'),
});

export type CreateOrganizationRequest = z.infer<typeof CreateOrganizationRequestSchema>;

export const AllowedOrganizationTypesResponseSchema = z.object({
  types: z
    .array(TenantTypeSchema)
    .describe('Tenant types a user is permitted to choose when creating an organization on this instance.'),
});

export type AllowedOrganizationTypesResponse = z.infer<typeof AllowedOrganizationTypesResponseSchema>;

export const UpdateOrganizationRequestSchema = z.object({
  name: z
    .string()
    .min(1, 'Organization name is required')
    .max(100, 'Organization name must be less than 100 characters')
    .optional()
    .describe('Updated organization name (1–100 characters)'),
  logo: z.string().nullable().optional().describe('Updated URL to the organization logo image'),
  email: z
    .string()
    .email('Must be a valid email')
    .nullable()
    .optional()
    .describe('Updated contact email for the organization'),
  country: z.string().max(100).nullable().optional().describe('Updated country for the organization'),
  metadata: z.string().nullable().optional().describe('Updated JSON-encoded metadata'),
});

export type UpdateOrganizationRequest = z.infer<typeof UpdateOrganizationRequestSchema>;

export const OrganizationWithRoleSchema = z.object({
  id: z.string().describe('Unique identifier for the organization'),
  name: z.string().describe('Display name of the organization'),
  tenantType: TenantTypeSchema.describe('Whether the organization is a demand or supply customer'),
  logo: z.string().nullable().describe('URL to the organization logo image'),
  role: z
    .string()
    .describe('Current role display name, or "Managed role" when the assignment belongs to a private catalog'),
  assignedRoleId: z
    .string()
    .nullable()
    .describe(
      "ID of the user's assigned OrganizationMemberRole, or null when no role is assigned or the role belongs to a private catalog.",
    ),
  permissions: z
    .array(z.string())
    .describe(
      'The resource:action permission keys granted to the current user within this organization. Drives UI-side `can*` checks. Empty array if no role is assigned.',
    ),
  isDefaultOrg: z.boolean().nullable().describe('Whether this is the default organization for the user'),
});

export type OrganizationWithRole = z.infer<typeof OrganizationWithRoleSchema>;

export const SetActiveResponseSchema = z.object({
  success: z.boolean().describe('Whether the active organization was successfully changed'),
  organizationId: z.string().describe('ID of the newly active organization'),
});

export type SetActiveResponse = z.infer<typeof SetActiveResponseSchema>;

export const InvitationStatusSchema = z
  .enum(['pending', 'accepted', 'rejected', 'canceled', 'expired'])
  .describe(
    "Current status of the invitation. 'expired' is derived at read time when the underlying invitation is still 'pending' in the database but its expiresAt has passed.",
  );
export type InvitationStatus = z.infer<typeof InvitationStatusSchema>;

export const InvitationSchema = z.object({
  id: z.string().describe('Unique identifier for the invitation'),
  email: z.string().describe('Email address the invitation was sent to'),
  inviterId: z.string().describe('ID of the user who sent the invitation'),
  organizationId: z.string().describe('ID of the organization the user is invited to'),
  role: z.string().describe('Display name of the role the invited user will receive upon acceptance'),
  roleId: z
    .string()
    .nullable()
    .describe('ID of the assigned RBAC role, or null when the role is private to another application catalog'),
  status: InvitationStatusSchema.describe('Current status of the invitation'),
  createdAt: z.coerce.date().describe('When the invitation was created'),
  expiresAt: z.coerce.date().describe('When the invitation expires'),
});

export type Invitation = z.infer<typeof InvitationSchema>;

export const CreateInvitationRequestSchema = z.object({
  email: z.string().email('A valid email is required').describe('Email address to send the invitation to'),
  roleId: z
    .string()
    .min(1, 'A role is required')
    .describe('ID of the system or organization-scoped custom role to assign upon acceptance'),
});

export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequestSchema>;

export const InvitationIdParamsSchema = z.object({
  invitationId: z.string().describe('Unique identifier of the invitation'),
});

export const InvitationWithOrganizationSchema = InvitationSchema.extend({
  organizationName: z.string().describe('Name of the organization the invitation is for'),
});

export type InvitationWithOrganization = z.infer<typeof InvitationWithOrganizationSchema>;
