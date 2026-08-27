import { initContract } from '@ts-rest/core';
import {
  DeviceSecretAuditListResponseSchema,
  DeviceSecretAuditQuerySchema,
  DeviceSecretDeviceParamsSchema,
  DeviceSecretRevealRequestResponseSchema,
  DeviceSecretRevealStatusParamsSchema,
  DeviceSecretRevealStatusResponseSchema,
  DeviceSecretVersionListSchema,
  DeviceSecretVersionMetaSchema,
  DeviceSecretVersionParamsSchema,
  DeviceSecretWriteRequestSchema,
} from '../schemas/device-secrets';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';

const c = initContract();

export const deviceSecretRoutes = c.router({
  listDeviceSecretVersions: {
    method: 'GET',
    path: '/devices/:deviceId/secrets/versions',
    pathParams: DeviceSecretDeviceParamsSchema,
    responses: {
      200: DeviceSecretVersionListSchema,
      401: ErrorResponseSchema,
      403: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'List a device’s secret version history',
    description:
      'Returns version metadata for every stored device secret (per purpose), newest first. Metadata only — no plaintext, no ciphertext. Gated to operator Owners/Admins, session auth only. Returns 404 if the device does not exist.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  writeDeviceSecret: {
    method: 'POST',
    path: '/devices/:deviceId/secrets',
    pathParams: DeviceSecretDeviceParamsSchema,
    body: DeviceSecretWriteRequestSchema,
    responses: {
      201: DeviceSecretVersionMetaSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      403: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Write a new device-secret version',
    description:
      'Seals the supplied secret material to the device’s zone key (the hub cannot open it afterwards) and appends it as the next version. Audited. Gated to operator Owners/Admins, session auth only. Returns 409 if the device’s zone is not enrolled (nothing to seal to) and 404 if the device does not exist.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  requestDeviceSecretReveal: {
    method: 'POST',
    path: '/devices/:deviceId/secrets/:purpose/versions/:version/reveal',
    pathParams: DeviceSecretVersionParamsSchema,
    body: c.type<Record<string, never>>(),
    responses: {
      202: DeviceSecretRevealRequestResponseSchema,
      401: ErrorResponseSchema,
      403: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Request decryption of a device-secret version (async)',
    description:
      'Kicks off a reveal: the hub forwards the sealed blob to the device’s zone bridge to open and re-seal back. Returns a requestId immediately — the bridge round-trip is asynchronous (poll the reveal-status endpoint). The disclosure is audited. Gated to operator Owners/Admins, session auth only. Returns 409 if the secret is invalidated (re-keyed) and 404 if the device/version does not exist.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  getDeviceSecretRevealStatus: {
    method: 'GET',
    path: '/devices/:deviceId/secrets/reveal/:requestId',
    pathParams: DeviceSecretRevealStatusParamsSchema,
    responses: {
      200: DeviceSecretRevealStatusResponseSchema,
      401: ErrorResponseSchema,
      403: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Poll an async reveal request for the decrypted secret',
    description:
      'Returns pending while the bridge round-trip is in flight, ready (with the plaintext, once) when the bridge has replied, or unavailable if the bridge is offline / the request timed out. The plaintext is returned exactly once then discarded. Gated to operator Owners/Admins, session auth only.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  listDeviceSecretAuditEvents: {
    method: 'GET',
    path: '/devices/:deviceId/secrets/audit',
    pathParams: DeviceSecretDeviceParamsSchema,
    query: DeviceSecretAuditQuerySchema,
    responses: {
      200: DeviceSecretAuditListResponseSchema,
      401: ErrorResponseSchema,
      403: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'List a device’s secret audit trail',
    description:
      'Returns the device-secret audit events for the device, newest first, as a paginated envelope. Metadata only — rows never contain secret material, and actor ids are resolved to a display label (user email or data center name) where possible. Gated to operator Owners/Admins, session auth only. Returns 404 if the device does not exist.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
