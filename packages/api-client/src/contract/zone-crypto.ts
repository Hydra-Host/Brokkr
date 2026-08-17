import { initContract } from '@ts-rest/core';
import { ErrorResponseSchema } from '../schemas/responses';
import {
  EnrollmentParamsSchema,
  EnrollmentRequestSchema,
  EnrollmentResponseSchema,
  InvalidateRegistrationTokenParamsSchema,
  InvalidateRegistrationTokenResponseSchema,
  ListRegistrationTokensParamsSchema,
  ListRegistrationTokensResponseSchema,
  MintRegistrationTokenConflictSchema,
  MintRegistrationTokenParamsSchema,
  MintRegistrationTokenRequestSchema,
  MintRegistrationTokenResponseSchema,
} from '../schemas/zone-crypto';
import { type RouteMetadata } from './metadata';

const c = initContract();

export const zoneCryptoRoutes = c.router({
  enrollZone: {
    method: 'POST',
    path: '/zones/:zoneId/enroll',
    pathParams: EnrollmentParamsSchema,
    body: EnrollmentRequestSchema,
    responses: {
      200: EnrollmentResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      409: ErrorResponseSchema,
      410: ErrorResponseSchema,
      503: ErrorResponseSchema,
    },
    summary: 'Enroll a zone with a one-time registration token',
    description:
      'Accepts a registration token + bridge-generated zone_pub from a bridge on first boot. Hub validates the token (SHA-256 hash lookup against ZoneRegistrationToken, expiry check, consumption-state check), atomically marks the token consumed and upserts ZoneEnrollment with the presented zone_pub, then returns hub_pub plus a response MAC bound to (zone_id, zone_pub, hub_pub). Idempotent: re-presentation of the same (token, zone_pub) pair returns the same response (handles dropped responses on retry). A different zone_pub for an already-consumed token returns 409. Returns 503 when BROKKR_HUB_PRIVATE_KEY is unset on the hub (S1 not yet activated). Public endpoint — auth is by possession of the raw registration token, not Better Auth.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  listZoneRegistrationTokens: {
    method: 'GET',
    path: '/zones/:zoneId/registration-tokens',
    pathParams: ListRegistrationTokensParamsSchema,
    responses: {
      200: ListRegistrationTokensResponseSchema,
      401: ErrorResponseSchema,
      403: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'List a zone registration-token history',
    description:
      'Returns metadata for every registration token ever minted for the zone, newest first, with a derived status (unused / consumed / expired). Metadata only — the raw token is shown exactly once at mint time and is never recoverable here; tokenHash and consumedZonePub are not exposed. Gated to Hydrahost-staff Owners/Admins, session auth only. Returns 404 if the zoneId does not match an existing Zone row.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  mintZoneRegistrationToken: {
    method: 'POST',
    path: '/zones/:zoneId/registration-tokens',
    pathParams: MintRegistrationTokenParamsSchema,
    body: MintRegistrationTokenRequestSchema,
    responses: {
      201: MintRegistrationTokenResponseSchema,
      401: ErrorResponseSchema,
      403: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: MintRegistrationTokenConflictSchema,
    },
    summary: 'Mint a single-use zone registration token',
    description:
      'Generates a fresh registration token (32 bytes of CSPRNG entropy, base64url-encoded), stores its SHA-256 hash bound to the target zone, and returns the raw token EXACTLY ONCE in the response body. Operators must copy the token immediately and pass it to the bridge as BROKKR_REGISTRATION_TOKEN. The 24h expiry applies to unused tokens only; once a bridge consumes the token, the resulting enrollment is permanent until reset. Gated to Hydrahost-staff Owners/Admins, session auth only. Returns 409 with the existing tokenId if an unused, unexpired token already exists for this zone — invalidate it via DELETE first or wait for it to expire. Returns 404 if the zoneId does not match an existing Zone row.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  invalidateZoneRegistrationToken: {
    method: 'DELETE',
    path: '/zones/:zoneId/registration-tokens/:tokenId',
    pathParams: InvalidateRegistrationTokenParamsSchema,
    responses: {
      204: InvalidateRegistrationTokenResponseSchema,
      401: ErrorResponseSchema,
      403: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Invalidate an unused zone registration token',
    description:
      'Marks the named ZoneRegistrationToken as expired-effective-now so it can no longer be consumed by a bridge. Lets an admin replace a stuck or accidentally-minted token without waiting for the 24h TTL. Idempotent: invalidating an already-expired token returns 204. Returns 409 if the token has already been consumed by a bridge (the resulting enrollment cannot be undone via this endpoint — see zone reset). Returns 404 if no token with the given id exists for this zone. Gated to Hydrahost-staff Owners/Admins, session auth only.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
