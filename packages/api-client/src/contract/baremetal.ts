import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  CollectInventoryResponseSchema,
  CommissionServerRequestSchema,
  CreateReservationInviteRequestSchema,
  EditReservationInviteRequestSchema,
  ProvisionBaremetalResponseSchema,
  ProvisionServerRequestSchema,
  ServerFilterOptionsQuerySchema,
  ServerFilterOptionsSchema,
  ServerSchema,
  ServerUpdateResponseSchema,
  ServersQuerySchema,
  UpdateListingRequestSchema,
  UpdateNicknameRequestSchema,
  UpdateServerInfoRequestSchema,
} from '../schemas/baremetal';
import { DcimDeviceTestRunsListResponseSchema, DcimDeviceTestRunsQuerySchema } from '../schemas/dcim-test-runs';
import { PaginationQuerySchema, createPaginatedResponseSchema } from '../schemas/pagination';
import { DeviceReservationInviteSchema } from '../schemas/reservation-invites';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses, authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const baremetalRoutes = c.router({
  getServers: {
    method: 'GET',
    path: '/servers',
    query: ServersQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(ServerSchema),
    },
    summary: 'Get paginated baremetal devices for the current organization',
    description:
      'Returns a paginated list of all baremetal devices belonging to the authenticated organization. Supports filtering by device role and lifecycle status.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getServerFilterOptions: {
    method: 'GET',
    path: '/servers/filter-options',
    query: ServerFilterOptionsQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: ServerFilterOptionsSchema,
    },
    summary: 'Get pre-aggregated distinct values for the supplier devices filter dropdowns',
    description:
      "Returns the full set of distinct values currently observed across the supplier's devices for each filterable field. Aggregated server-side so the response stays roughly constant regardless of fleet size.",
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getServerTestRuns: {
    method: 'GET',
    path: '/servers/test-runs',
    query: DcimDeviceTestRunsQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: DcimDeviceTestRunsListResponseSchema,
    },
    summary: 'Get paginated device test runs for the current organization',
    description:
      'Returns a paginated list of hardware test runs for devices owned by the authenticated organization. Optionally filter by a specific device UUID, test type, or status.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getServerById: {
    method: 'GET',
    path: '/servers/:deviceId',
    pathParams: z.object({ deviceId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: ServerSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get baremetal device by ID',
    description:
      'Returns full details for a single baremetal device including specs, networking, listing, and deployment information.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getServerEcoMode: {
    method: 'GET',
    path: '/servers/:deviceId/eco-mode',
    pathParams: z.object({ deviceId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: z.boolean(),
      404: ErrorResponseSchema,
    },
    summary: 'Get eco mode status for a baremetal device',
    description:
      'Returns whether eco mode (automatic power-saving when idle) is currently enabled for the specified device.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  commissionServer: {
    method: 'POST',
    path: '/servers/commission',
    body: CommissionServerRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: ServerUpdateResponseSchema,
    },
    summary: 'Commission a discovered device',
    description:
      'Transitions a device from discovered-hosts status to commissioned using its BMC credentials; the zone is derived from the device.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  collectServerInventory: {
    method: 'POST',
    path: '/servers/:deviceId/collect-inventory',
    pathParams: z.object({ deviceId: z.string() }),
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: CollectInventoryResponseSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Run hardware discovery collection for a device',
    description:
      'Enqueues the inventory_collection saga for the device: the bridge waits for it to reach Brokkr Live, collects hardware facts (disks, CPU, NICs, memory), and reports back via discovery.complete. Asynchronous — returns the stable per-device job id immediately. If a collection is already active the same id is returned without starting a duplicate.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateServerListing: {
    method: 'PATCH',
    path: '/servers/:deviceId/listing',
    pathParams: z.object({ deviceId: z.string() }),
    body: UpdateListingRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: ServerSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update listing for a baremetal device',
    description:
      'Updates the marketplace listing configuration for a device, including pricing, visibility, and whether to accept interruptible-only reservations.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateServerNickname: {
    method: 'PATCH',
    path: '/servers/:deviceId/nickname',
    pathParams: z.object({ deviceId: z.string() }),
    body: UpdateNicknameRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: ServerSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update nickname for a baremetal device',
    description:
      'Sets or changes the operator-assigned nickname for a device. The nickname is displayed in the management UI for easier identification.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateServerInfo: {
    method: 'PATCH',
    path: '/servers/:deviceId',
    pathParams: z.object({ deviceId: z.string() }),
    body: UpdateServerInfoRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: ServerUpdateResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update baremetal device info (nickname, eco mode, PXE target)',
    description:
      'Updates mutable device properties such as nickname, eco mode setting, and per-device PXE boot firmware override. Only provided fields are updated.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  decommissionServer: {
    method: 'PATCH',
    path: '/servers/:deviceId/decommission',
    pathParams: z.object({ deviceId: z.string() }),
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      200: ServerUpdateResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update device to decommissioned status',
    description:
      'Marks a device as decommissioned, removing it from active inventory. The device record is retained for historical reporting.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  // tombstone: the re-commission flow is gone; this shipped public route stays in the spec as
  // `deprecated` for one release cycle, answering 410 — delete route + handler after that cycle.
  moveServerToDiscoveredHosts: {
    method: 'PATCH',
    path: '/servers/:deviceId/discovered-hosts',
    pathParams: z.object({ deviceId: z.string() }),
    body: z.object({}),
    deprecated: true,
    responses: {
      ...authedRoleGatedErrorResponses,
      410: ErrorResponseSchema,
    },
    summary: 'Update device to discovered hosts status (retired)',
    description:
      'Moves a device back to discovered-hosts status, effectively reversing its commissioning and making it available for re-commissioning.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  provisionBaremetalServer: {
    method: 'PATCH',
    path: '/servers/:deviceId/provision',
    pathParams: z.object({ deviceId: z.string() }),
    body: ProvisionServerRequestSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: ProvisionBaremetalResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Provision a baremetal device',
    description:
      'Initiates the provisioning workflow for a device, including OS installation, network configuration, and SSH key deployment.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getReservationInvitesByServer: {
    method: 'GET',
    path: '/servers/:deviceId/reservation-invites',
    pathParams: z.object({ deviceId: z.string() }),
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(DeviceReservationInviteSchema),
      404: ErrorResponseSchema,
    },
    summary: 'Get reservation invites by device ID',
    description:
      'Returns a paginated list of all reservation invites (pending, accepted, and expired) associated with the specified device.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  createReservationInvite: {
    method: 'POST',
    path: '/servers/:deviceId/reservation-invites',
    pathParams: z.object({ deviceId: z.string() }),
    body: CreateReservationInviteRequestSchema,
    responses: {
      ...authedErrorResponses,
      201: DeviceReservationInviteSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Create a reservation invite for demand customer',
    description:
      'Creates a new reservation invite for one or more devices, specifying pricing, contract terms, and a buyer email. The invite can be accepted by the buyer to start a reservation.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  editReservationInvite: {
    method: 'PATCH',
    path: '/reservation-invites/:inviteId',
    pathParams: z.object({ inviteId: z.string() }),
    body: EditReservationInviteRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: DeviceReservationInviteSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Edit a reservation invite',
    description: 'Updates the pricing, contract terms, or device list for an existing pending reservation invite.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  deleteReservationInvite: {
    method: 'DELETE',
    path: '/reservation-invites/:inviteId',
    pathParams: z.object({ inviteId: z.string() }),
    responses: {
      ...authedErrorResponses,
      204: z.void(),
      404: ErrorResponseSchema,
    },
    summary: 'Delete a reservation invite',
    description: 'Soft-deletes a pending reservation invite. Accepted invites cannot be deleted.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
