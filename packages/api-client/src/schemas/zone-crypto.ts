import { z } from 'zod';

const HexX25519PublicKeySchema = z
  .string()
  .length(64, 'X25519 public key must be exactly 64 hex characters (32 bytes)')
  .regex(/^[0-9a-f]{64}$/, 'X25519 public key must be lowercase hex');

const HmacSha256HexSchema = z
  .string()
  .length(64, 'HMAC-SHA256 hex must be exactly 64 characters (32 bytes)')
  .regex(/^[0-9a-f]{64}$/, 'HMAC-SHA256 hex must be lowercase');

export const EnrollmentParamsSchema = z.object({
  zoneId: z
    .string()
    .uuid('zoneId must be a valid UUID')
    .describe('UUID of the Zone being enrolled. Must match the zone the registration token was bound to at mint time.'),
});
export type EnrollmentParams = z.infer<typeof EnrollmentParamsSchema>;

export const EnrollmentRequestSchema = z.object({
  registration_token: z
    .string()
    .min(1, 'registration token is required')
    .max(256, 'registration token must be at most 256 characters')
    .describe(
      'Raw single-use registration token (24h TTL on unused, per-zone-bound). Hub SHA-256-hashes this to look up the stored hash in ZoneRegistrationToken and uses it as the HMAC key for verifying `mac` and computing the response MAC. The token IS the credential — possession proves authorization. Sent over TLS only; never logged on either side.',
    ),
  zone_pub: HexX25519PublicKeySchema.describe(
    'Bridge-generated zone X25519 public key (32 bytes, lowercase hex). The corresponding private key never leaves the bridge.',
  ),
  mac: HmacSha256HexSchema.describe(
    'HMAC-SHA256 hex over `zone_id` (UTF-8 bytes) || `zone_pub` (raw 32 bytes), keyed by the raw registration token. Defense-in-depth: catches body tampering even in MITM scenarios where TLS would also have to be broken to recompute. Hub verifies after token lookup.',
  ),
});
export type EnrollmentRequest = z.infer<typeof EnrollmentRequestSchema>;

export const EnrollmentResponseSchema = z.object({
  hub_pub: HexX25519PublicKeySchema.describe(
    'Hub static X25519 public key (32 bytes, lowercase hex). Derived from BROKKR_HUB_PRIVATE_KEY at hub boot; the same hub_pub is returned for every zone.',
  ),
  mac: HmacSha256HexSchema.describe(
    'HMAC-SHA256 hex over `zone_id` (UTF-8 bytes) || `zone_pub` (raw 32 bytes) || `hub_pub` (raw 32 bytes), keyed by the raw registration token. Authenticates the response and binds it to this specific request; the bridge verifies before persisting zone_crypto.',
  ),
});
export type EnrollmentResponse = z.infer<typeof EnrollmentResponseSchema>;

export const MintRegistrationTokenParamsSchema = z.object({
  zoneId: z
    .string()
    .uuid('zoneId must be a valid UUID')
    .describe('UUID of the Zone the new registration token will be bound to.'),
});
export type MintRegistrationTokenParams = z.infer<typeof MintRegistrationTokenParamsSchema>;

export const MintRegistrationTokenRequestSchema = z
  .object({})
  .describe(
    'Empty body. The mint endpoint takes its inputs from the path parameter and the authenticated admin context.',
  );
export type MintRegistrationTokenRequest = z.infer<typeof MintRegistrationTokenRequestSchema>;

export const MintRegistrationTokenResponseSchema = z.object({
  token: z
    .string()
    .describe(
      'Raw single-use registration token (base64url-encoded 32 bytes of CSPRNG entropy). Shown EXACTLY ONCE in this response and cannot be retrieved later — operators must copy it immediately and pass it to the bridge as BROKKR_REGISTRATION_TOKEN. The hub stores only the SHA-256 hash.',
    ),
  tokenId: z.string().uuid().describe('UUID of the persisted ZoneRegistrationToken row, for audit cross-referencing.'),
  zoneId: z.string().uuid().describe('UUID of the zone this token enrolls (echoed back from the path parameter).'),
  expiresAt: z.coerce
    .date()
    .describe(
      'ISO 8601 timestamp after which an unused token is rejected. Defaults to 24 hours from creation per S1 Decision 2. Once consumed, expiry no longer applies.',
    ),
  createdAt: z.coerce.date().describe('When the token was minted.'),
  createdById: z.string().describe('User ID of the admin who minted this token (audit).'),
});
export type MintRegistrationTokenResponse = z.infer<typeof MintRegistrationTokenResponseSchema>;

// 409 on mint: only one unused token may be in flight per zone, closing the dual-mint silent-overwrite race (two bridges race-enrolling, second wins, first goes dark).
export const MintRegistrationTokenConflictSchema = z.object({
  message: z.string().describe('Human-readable error summary.'),
  existingTokenId: z
    .string()
    .uuid()
    .describe('UUID of the existing unused token blocking the mint. Pass to DELETE to invalidate.'),
});
export type MintRegistrationTokenConflict = z.infer<typeof MintRegistrationTokenConflictSchema>;

export const InvalidateRegistrationTokenParamsSchema = z.object({
  zoneId: z.string().uuid('zoneId must be a valid UUID').describe('UUID of the Zone the token is bound to.'),
  tokenId: z
    .string()
    .uuid('tokenId must be a valid UUID')
    .describe('UUID of the ZoneRegistrationToken row to invalidate.'),
});
export type InvalidateRegistrationTokenParams = z.infer<typeof InvalidateRegistrationTokenParamsSchema>;

export const InvalidateRegistrationTokenResponseSchema = z
  .object({})
  .describe(
    'Empty body. The token row is preserved for audit; expiresAt is set to now() so it can no longer be consumed.',
  );
export type InvalidateRegistrationTokenResponse = z.infer<typeof InvalidateRegistrationTokenResponseSchema>;

export const ListRegistrationTokensParamsSchema = z.object({
  zoneId: z
    .string()
    .uuid('zoneId must be a valid UUID')
    .describe('UUID of the Zone whose registration-token history is being listed.'),
});
export type ListRegistrationTokensParams = z.infer<typeof ListRegistrationTokensParamsSchema>;

export const RegistrationTokenStatusSchema = z
  .enum(['unused', 'consumed', 'expired'])
  .describe(
    'Derived lifecycle state: "consumed" once a bridge has enrolled with it, "expired" if its 24h TTL has elapsed unused, otherwise "unused".',
  );
export type RegistrationTokenStatus = z.infer<typeof RegistrationTokenStatusSchema>;

export const ZoneRegistrationTokenMetadataSchema = z.object({
  id: z.string().uuid().describe('UUID of the ZoneRegistrationToken row.'),
  zoneId: z.string().uuid().describe('UUID of the zone this token is bound to.'),
  mintedById: z.string().describe('User ID of the admin who minted this token (from createdById).'),
  mintedByEmail: z
    .string()
    .nullable()
    .describe('Email of the admin who minted this token, resolved from the User relation; null if the user is gone.'),
  mintedAt: z.coerce.date().describe('When the token was minted (createdAt).'),
  expiresAt: z.coerce.date().describe('When an unused token expires (24h after mint per S1 Decision 2).'),
  consumedAt: z.coerce
    .date()
    .nullable()
    .describe('When a bridge consumed this token to enroll, or null if it has not been consumed.'),
  status: RegistrationTokenStatusSchema,
});
export type ZoneRegistrationTokenMetadata = z.infer<typeof ZoneRegistrationTokenMetadataSchema>;

export const ListRegistrationTokensResponseSchema = z
  .array(ZoneRegistrationTokenMetadataSchema)
  .describe('All registration tokens minted for the zone, newest first. Metadata only — never the raw token.');
export type ListRegistrationTokensResponse = z.infer<typeof ListRegistrationTokensResponseSchema>;
