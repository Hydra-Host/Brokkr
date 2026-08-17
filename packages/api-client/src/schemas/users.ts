import { z } from 'zod';

export const UpdateUserRequestSchema = z.object({
  firstName: z.string().min(1).optional().describe('Updated first name for the user'),
  lastName: z.string().min(1).optional().describe('Updated last name for the user'),
});

export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

export const SetDefaultOrganizationRequestSchema = z.object({
  organizationId: z.string().uuid().describe('UUID of the organization to set as default'),
});

export type SetDefaultOrganizationRequest = z.infer<typeof SetDefaultOrganizationRequestSchema>;

export const SetDefaultOrganizationResponseSchema = z.object({
  userId: z.string().describe('ID of the user whose default organization was set'),
  organizationId: z.string().describe('ID of the organization now marked as default'),
  role: z.string().describe("The user's role within the organization"),
  isDefaultOrg: z.boolean().describe('Whether this membership is the user default (always true on success)'),
});

export type SetDefaultOrganizationResponse = z.infer<typeof SetDefaultOrganizationResponseSchema>;

export const UserSchema = z.object({
  id: z.string().describe('Unique identifier for the user'),
  email: z.string().email().describe('Email address of the user'),
  emailVerified: z.boolean().describe('Whether the user has verified their email'),
  name: z.string().nullable().describe('Display name of the user'),
  image: z.string().nullable().describe('URL to the user profile image'),
  createdAt: z.coerce.date().describe('When the user account was created'),
  updatedAt: z.coerce.date().describe('When the user account was last updated'),
  role: z.string().describe('Global role assigned to the user'),
  banned: z.boolean().describe('Whether the user is currently banned'),
  banReason: z.string().nullable().describe('Reason the user was banned'),
  banExpires: z.coerce.date().nullable().describe('When the ban expires, or null for permanent'),
});

export type User = z.infer<typeof UserSchema>;

// Deliberately omits internal account state (role, ban fields, auth0Id, phoneNumber, emailVerified) so a profile update never serializes moderation/identity fields back to the caller.
export const UserProfileSchema = z.object({
  id: z.string().describe('Unique identifier for the user'),
  email: z.string().email().describe('Email address of the user'),
  firstName: z.string().nullable().describe('First name of the user'),
  lastName: z.string().nullable().describe('Last name of the user'),
  name: z.string().nullable().describe('Display name of the user'),
  image: z.string().nullable().describe('URL to the user profile image'),
  createdAt: z.coerce.date().describe('When the user account was created'),
  updatedAt: z.coerce.date().nullable().describe('When the user account was last updated'),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

export const AuthOrganizationSchema = z.object({
  id: z.string().describe('Unique identifier for the organization'),
  name: z.string().describe('Display name of the organization'),
  slug: z.string().describe('URL-friendly slug for the organization'),
  logo: z.string().nullable().describe('URL to the organization logo image'),
  metadata: z.string().nullable().describe('JSON-encoded metadata for the organization'),
  createdAt: z.coerce.date().describe('When the organization was created'),
  updatedAt: z.coerce.date().describe('When the organization was last updated'),
});

export type AuthOrganization = z.infer<typeof AuthOrganizationSchema>;

export const MemberSchema = z.object({
  id: z.string().describe('Unique identifier for the membership'),
  userId: z.string().describe('ID of the user in this membership'),
  organizationId: z.string().describe('ID of the organization the user belongs to'),
  role: z.string().describe('Role of the user within the organization'),
  createdAt: z.coerce.date().describe('When the membership was created'),
  updatedAt: z.coerce.date().describe('When the membership was last updated'),
});

export type Member = z.infer<typeof MemberSchema>;
