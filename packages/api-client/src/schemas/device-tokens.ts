import { DeviceTokenContext, DeviceTokenRevocationReason, DeviceTokenStatus } from '@repo/database/enums';
import { z } from 'zod';
import { zodEnumFromPrisma } from './prisma-enum';

export const DeviceTokenContextSchema = zodEnumFromPrisma(DeviceTokenContext).describe(
  'Operational context where the device token is valid.',
);

export const DeviceTokenStatusSchema = zodEnumFromPrisma(DeviceTokenStatus).describe(
  'Current lifecycle state of the device token.',
);

export const DeviceTokenRevocationReasonSchema = zodEnumFromPrisma(DeviceTokenRevocationReason).describe(
  'Reason an active device token was revoked.',
);

export const DeviceTokenSchema = z.object({
  id: z.string().uuid().describe('Device token UUID.'),
  deviceId: z.string().uuid().describe('Device UUID the token authenticates.'),
  deploymentId: z.string().uuid().nullable().describe('Deployment UUID associated with the token, when applicable.'),
  context: DeviceTokenContextSchema.describe('Context where this token is accepted.'),
  displayId: z.string().describe('Short non-secret identifier derived from the token hash.'),
  status: DeviceTokenStatusSchema.describe('Current token status.'),
  rotationGeneration: z
    .number()
    .int()
    .nonnegative()
    .describe('Number of times this token row has been rotated or revoked for audit compaction.'),
  expiresAt: z.coerce.date().nullable().describe('When the token expires, or null for no scheduled expiry.'),
  lastUsedAt: z.coerce.date().nullable().describe('Most recent accepted use time after throttling.'),
  lastUsedIp: z.string().nullable().describe('Most recent accepted source IP after throttling.'),
  revokedAt: z.coerce.date().nullable().describe('When the token was revoked, if revoked.'),
  revokedReason: DeviceTokenRevocationReasonSchema.nullable().describe('Reason recorded when the token was revoked.'),
  revokedNote: z.string().nullable().describe('Optional human note recorded at revocation time.'),
  issuedBy: z.string().nullable().describe('Actor that issued the token.'),
  createdAt: z.coerce.date().describe('When the token row was created.'),
  updatedAt: z.coerce.date().describe('When the token row was last updated.'),
});

export const IssueBrokkrLiveDeviceTokenResponseSchema = z.object({
  token: DeviceTokenSchema.describe('Metadata for the issued Brokkr Live token.'),
  plaintext: z.string().describe('Opaque token plaintext. Returned only once and never stored raw.'),
});

export type { DeviceTokenContext, DeviceTokenRevocationReason, DeviceTokenStatus };
export type DeviceToken = z.infer<typeof DeviceTokenSchema>;
export type IssueBrokkrLiveDeviceTokenResponse = z.infer<typeof IssueBrokkrLiveDeviceTokenResponseSchema>;

export const DeviceTokenSummarySchema = DeviceTokenSchema.pick({
  id: true,
  deviceId: true,
  context: true,
  displayId: true,
  status: true,
  rotationGeneration: true,
  expiresAt: true,
  lastUsedAt: true,
  lastUsedIp: true,
  revokedAt: true,
  revokedReason: true,
  createdAt: true,
}).describe('Token status and recency for the device page. Never carries the token or its hash.');
export type DeviceTokenSummary = z.infer<typeof DeviceTokenSummarySchema>;
