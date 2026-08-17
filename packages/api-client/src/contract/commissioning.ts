import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  CommissioningActionResponseSchema,
  CommissioningDevicesRequestSchema,
  CommissioningDevicesResponseSchema,
  CommissioningEnrichRequestSchema,
  CommissioningEnrichResponseSchema,
  CommissioningEnrichStatusResponseSchema,
  CommissioningManagementSubnetsResponseSchema,
  CommissioningProgressResponseSchema,
  CommissioningRefreshEnrichmentRequestSchema,
  CommissioningRefreshEnrichmentResponseSchema,
  CommissioningRetryRequestSchema,
  CommissioningScanPollResponseSchema,
  CommissioningScanRequestSchema,
  CommissioningScanResponseSchema,
  CommissioningValidateRequestSchema,
  CommissioningValidateResponseSchema,
} from '../schemas/commissioning';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';

const c = initContract();

const zoneParams = z.object({ zoneId: z.string().describe('Zone UUID to commission devices into') });
const deviceParams = z.object({
  zoneId: z.string().describe('Zone UUID to commission devices into'),
  deviceId: z.string().describe('Brokkr Device UUID of the commissioning device (role=null)'),
});

export const commissioningRoutes = c.router({
  scanZoneManagementSubnets: {
    method: 'POST',
    path: '/zones/:zoneId/commissioning/scan',
    pathParams: zoneParams,
    body: CommissioningScanRequestSchema,
    responses: {
      200: CommissioningScanResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: "Scan a zone's management subnets for new devices",
    description:
      'Fans out a network_scan saga to the bridge for every MANAGEMENT prefix of the zone (or the supplied CIDR override) and returns a scan-session id to poll for aggregated results.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  listZoneManagementSubnets: {
    method: 'GET',
    path: '/zones/:zoneId/commissioning/management-subnets',
    pathParams: zoneParams,
    responses: {
      200: CommissioningManagementSubnetsResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: "List a zone's MANAGEMENT subnets",
    description:
      "Returns the zone's MANAGEMENT prefixes as normalized CIDR strings, for populating the commissioning scan-target selector.",
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  pollCommissioningScan: {
    method: 'GET',
    path: '/zones/:zoneId/commissioning/scan/:sessionId',
    pathParams: z.object({
      zoneId: z.string().describe('Zone UUID the scan belongs to'),
      sessionId: z.string().describe('Scan-session id returned by the scan request'),
    }),
    responses: {
      200: CommissioningScanPollResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Poll a network-scan session',
    description:
      'Aggregates per-subnet network_scan results for the session and returns the deduplicated set of newly discovered devices once every subnet has finished.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  enrichCommissioningDevice: {
    method: 'POST',
    path: '/zones/:zoneId/commissioning/enrich',
    pathParams: zoneParams,
    body: CommissioningEnrichRequestSchema,
    responses: {
      200: CommissioningEnrichResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Enrich a scanned device via PXE',
    description:
      'Enqueues the enrich_via_pxe saga so the bridge reboots the device into the discovery initrd, which writes NIC MAC/serials back to the discovery pending store.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  pollCommissioningEnrichment: {
    method: 'GET',
    path: '/zones/:zoneId/commissioning/enrich/:planId',
    pathParams: z.object({
      zoneId: z.string().describe('Zone UUID the device is being commissioned into'),
      planId: z.string().describe('Plan id returned by the enrich endpoint'),
    }),
    responses: {
      200: CommissioningEnrichStatusResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Poll the status of an enrich_via_pxe saga',
    description:
      'Reads the bridge saga plan for the given enrich plan id and reports whether enrichment is pending, complete, or failed (with the failure detail), so the UI can surface an error instead of spinning forever.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  cancelCommissioningEnrichment: {
    method: 'POST',
    path: '/zones/:zoneId/commissioning/enrich/:planId/cancel',
    pathParams: z.object({
      zoneId: z.string().describe('Zone UUID the device is being commissioned into'),
      planId: z.string().describe('Plan id returned by the enrich endpoint'),
    }),
    body: z.object({}).describe('No body'),
    responses: {
      200: CommissioningActionResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Cancel an in-flight enrich_via_pxe saga',
    description:
      'Cancels an enrich attempt that has no Device row (temp plan id): marks the bridge saga plan cancelled and ' +
      'best-effort removes queued jobs from both the lifecycle and collection queues so a device that never booted ' +
      'brokkr-live stops being retried.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  refreshCommissioningEnrichment: {
    method: 'POST',
    path: '/zones/:zoneId/commissioning/enrich/refresh',
    pathParams: zoneParams,
    body: CommissioningRefreshEnrichmentRequestSchema,
    responses: {
      200: CommissioningRefreshEnrichmentResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Refresh enrichment data for scanned devices',
    description:
      'Re-reads the iPXE pending discovery store and returns the submitted devices with their NIC MAC/serial enrichment fields refreshed.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  validateCommissioning: {
    method: 'POST',
    path: '/zones/:zoneId/commissioning/validate',
    pathParams: zoneParams,
    body: CommissioningValidateRequestSchema,
    responses: {
      200: CommissioningValidateResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Validate IPMI credentials before commissioning',
    description:
      'Runs a power_status check per device against the bridge to confirm the IPMI credentials work. Stateless — the per-device pass/fail result is tracked client-side until the operator commissions.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  commissionDevices: {
    method: 'POST',
    path: '/zones/:zoneId/commissioning/commission',
    pathParams: zoneParams,
    body: CommissioningDevicesRequestSchema,
    responses: {
      200: CommissioningDevicesResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Commission discovered devices',
    description:
      'Creates a role=null Brokkr Device per device (the commissioning record — promoted to Server at Acknowledge) with IPMI/NIC interfaces and IPs, and enqueues the commission saga to the bridge.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getCommissioningProgress: {
    method: 'GET',
    path: '/zones/:zoneId/commissioning/progress',
    pathParams: zoneParams,
    responses: {
      200: CommissioningProgressResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get commissioning progress for the current organization',
    description:
      'Returns the unacknowledged commissioning-progress records for the current organization, including per-step saga progress for in-flight devices.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  acknowledgeCommissioning: {
    method: 'POST',
    path: '/zones/:zoneId/commissioning/progress/:deviceId/acknowledge',
    pathParams: deviceParams,
    body: z.object({}).describe('No body'),
    responses: {
      200: CommissioningActionResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Acknowledge a qualified device (promote to Server)',
    description:
      'Promotes a qualified commissioning device from role=null to role=Server (claims the role + creates the Server row), removing it from the commissioning view.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  retryCommissioning: {
    method: 'POST',
    path: '/zones/:zoneId/commissioning/progress/:deviceId/retry',
    pathParams: deviceParams,
    body: CommissioningRetryRequestSchema,
    responses: {
      200: CommissioningActionResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Retry a failed commissioning',
    description:
      'Soft-deletes the failed commissioning device (tearing down its bridge job + saga plans) and commissions a fresh one from the supplied device input — a Cancel followed by an Commission. BMC credentials must be re-supplied.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  retryCommissioningStep: {
    method: 'POST',
    path: '/zones/:zoneId/commissioning/progress/:deviceId/retry-step',
    pathParams: deviceParams,
    body: z.object({}).describe('No body — targets whichever saga step is currently failed'),
    responses: {
      200: CommissioningActionResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Retry the failed saga step in-place',
    description:
      'Resets the single failed saga step to pending (clearing its error) and re-enqueues the saga so the bridge resumes from that step. ' +
      'Unlike the full Retry (which soft-deletes and re-commissions), this preserves the device record and all prior completed steps.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  cancelCommissioning: {
    method: 'POST',
    path: '/zones/:zoneId/commissioning/progress/:deviceId/cancel',
    pathParams: deviceParams,
    body: z.object({}).describe('No body'),
    responses: {
      200: CommissioningActionResponseSchema,
      400: ErrorResponseSchema,
      401: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Cancel an in-flight commissioning',
    description:
      'Soft-deletes the commissioning device and best-effort removes any queued BullMQ job and in-flight saga plans.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
