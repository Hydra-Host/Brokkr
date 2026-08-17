import { initContract } from '@ts-rest/core';
import {
  CreateDeviceDiagnosticsRequestSchema,
  DeviceDiagnosticsResponseSchema,
  PhoneHomeResponseSchema,
} from '../schemas/bmc';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';

const c = initContract();

export const bmcRequestsRoutes = c.router({
  phoneHome: {
    method: 'GET',
    path: '/bmc/phone-home',
    responses: {
      200: PhoneHomeResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Handle phone-home callbacks',
    description:
      'Accepts Bearer-token-authenticated phone-home callbacks from devices. The device identity is resolved entirely from the token — no body or query parameters required. Successful requests mark the device as provisioned and refresh its running power state.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  phoneHomePost: {
    method: 'POST',
    path: '/bmc/phone-home',
    body: null,
    responses: {
      200: PhoneHomeResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Handle phone-home callbacks (POST)',
    description:
      'POST variant of the phone-home endpoint. Identity is resolved from the Bearer token — the body is ignored.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },

  createDeviceDiagnostics: {
    method: 'POST',
    path: '/bmc/diagnostics',
    body: CreateDeviceDiagnosticsRequestSchema,
    responses: {
      201: DeviceDiagnosticsResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Create a new device diagnostics report',
    description:
      'Stores a diagnostics report (GPU, driver, storage, thermal, etc.) collected from a device during provisioning or health checks.',
    metadata: { visibility: 'internal' } satisfies RouteMetadata,
  },
});
