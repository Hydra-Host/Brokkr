import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { PaginationQuerySchema, createPaginatedResponseSchema } from '../schemas/pagination';
import { ErrorResponseSchema } from '../schemas/responses';
import {
  ContactInputSchema,
  CreateZoneRequestSchema,
  CreateZoneResponseSchema,
  UpdatePrimaryAddressSchema,
  UpdateShippingAddressSchema,
  UpdateZoneNameSchema,
  ZoneContactSchema,
  ZoneDhcpPrefixSummarySchema,
  ZoneListItemSchema,
  ZoneRedisCredentialSchema,
  ZoneSchema,
  ZoneVrrpPrefixSummarySchema,
} from '../schemas/zones';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses, authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const zonesRoutes = c.router({
  getZones: {
    method: 'GET',
    path: '/zones',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(ZoneListItemSchema),
    },
    summary: 'Get all zones for the current organization',
    description: 'Returns a paginated list of zones belonging to the current organization.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  createZone: {
    method: 'POST',
    path: '/zones',
    body: CreateZoneRequestSchema,
    responses: {
      ...authedErrorResponses,
      201: CreateZoneResponseSchema,
      400: ErrorResponseSchema,
    },
    summary: 'Create a new zone',
    description: 'Creates a new zone with addresses and contacts.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getZoneById: {
    method: 'GET',
    path: '/zones/:zoneId',
    pathParams: z.object({ zoneId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: ZoneSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get zone by ID',
    description:
      'Returns the full zone record including addresses and contacts. Returns 404 if not found or not owned by the current organization.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateZoneName: {
    method: 'PATCH',
    path: '/zones/:zoneId/name',
    pathParams: z.object({ zoneId: z.string() }),
    body: UpdateZoneNameSchema,
    responses: {
      ...authedErrorResponses,
      200: ZoneSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update zone name',
    description: 'Updates the display name of a zone.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateZonePrimaryAddress: {
    method: 'PATCH',
    path: '/zones/:zoneId/primary-address',
    pathParams: z.object({ zoneId: z.string() }),
    body: UpdatePrimaryAddressSchema,
    responses: {
      ...authedErrorResponses,
      200: ZoneSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update zone primary address',
    description: 'Replaces the primary physical address of the zone.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateZoneShippingAddress: {
    method: 'PATCH',
    path: '/zones/:zoneId/shipping-address',
    pathParams: z.object({ zoneId: z.string() }),
    body: UpdateShippingAddressSchema,
    responses: {
      ...authedErrorResponses,
      200: ZoneSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update zone shipping address',
    description: 'Replaces the shipping address of the zone.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  rotateZoneRedisCredential: {
    method: 'POST',
    path: '/zones/:zoneId/redis-credential/rotate',
    pathParams: z.object({ zoneId: z.string() }),
    body: z.object({}),
    responses: {
      ...authedRoleGatedErrorResponses,
      201: ZoneRedisCredentialSchema,
      404: ErrorResponseSchema,
      503: ErrorResponseSchema,
    },
    summary: "Rotate a zone's Redis ACL credential",
    description:
      "Generates a fresh password for the zone's Redis ACL user (brokkr-spoke-<zoneId>), applies it to Redis, and returns it EXACTLY ONCE — the hub stores only the password hash. Available only when the hub runs with REDIS_ACL_MANAGEMENT_ENABLED=true (returns 503 otherwise). Use this to recover a credential that was lost or never captured (e.g. zones created before the flag was enabled). Bridges using the old password lose access immediately.",
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  deleteZone: {
    method: 'DELETE',
    path: '/zones/:zoneId',
    pathParams: z.object({ zoneId: z.string() }),
    responses: {
      ...authedErrorResponses,
      204: z.void(),
      404: ErrorResponseSchema,
    },
    summary: 'Delete a zone',
    description: 'Soft-deletes a zone.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getZoneContacts: {
    method: 'GET',
    path: '/zones/:zoneId/contacts',
    pathParams: z.object({ zoneId: z.string() }),
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(ZoneContactSchema),
      404: ErrorResponseSchema,
    },
    summary: 'Get all contacts for a zone',
    description: 'Returns a paginated list of contacts associated with the specified zone.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  createZoneContact: {
    method: 'POST',
    path: '/zones/:zoneId/contacts',
    pathParams: z.object({ zoneId: z.string() }),
    body: ContactInputSchema,
    responses: {
      ...authedErrorResponses,
      201: ZoneContactSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Create a contact for a zone',
    description:
      'Adds a new contact to the specified zone. Contacts are used for on-site communication and coordination.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getZoneContact: {
    method: 'GET',
    path: '/zones/:zoneId/contacts/:contactId',
    pathParams: z.object({ zoneId: z.string(), contactId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: ZoneContactSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get a single contact by ID',
    description: 'Returns the contact details for a specific contact within a zone.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  updateZoneContact: {
    method: 'PUT',
    path: '/zones/:zoneId/contacts/:contactId',
    pathParams: z.object({ zoneId: z.string(), contactId: z.string() }),
    body: ContactInputSchema,
    responses: {
      ...authedErrorResponses,
      200: ZoneContactSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Update a contact',
    description: 'Replaces all fields of an existing zone contact. The full contact input must be provided.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  deleteZoneContact: {
    method: 'DELETE',
    path: '/zones/:zoneId/contacts/:contactId',
    pathParams: z.object({ zoneId: z.string(), contactId: z.string() }),
    responses: {
      ...authedErrorResponses,
      204: z.void(),
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Delete a contact',
    description: 'Soft-deletes a contact from the zone.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getZoneDhcpPrefixes: {
    method: 'GET',
    path: '/zones/:zoneId/dhcp/prefixes',
    pathParams: z.object({ zoneId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: z.array(ZoneDhcpPrefixSummarySchema),
      404: ErrorResponseSchema,
    },
    summary: 'List DHCP prefix summaries for a zone',
    description:
      'Returns all prefixes belonging to a zone with their DHCP mode and eligibility status. A prefix is DHCP-eligible when it is IPv4, zone-scoped, and not assigned the NAT role. Used by the zone DHCP card to render per-prefix enabled/disabled state.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getZoneVrrpPrefixes: {
    method: 'GET',
    path: '/zones/:zoneId/vrrp/prefixes',
    pathParams: z.object({ zoneId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: z.array(ZoneVrrpPrefixSummarySchema),
      404: ErrorResponseSchema,
    },
    summary: 'List VRRP prefix summaries for a zone',
    description:
      'Returns all prefixes in the zone that have a VRRP floating IP assigned, along with their VIP address and per-bridge interface bindings. Used by the zone VRRP card to show VIP assignment state.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },
});
