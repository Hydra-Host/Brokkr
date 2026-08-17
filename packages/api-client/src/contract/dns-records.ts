import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import {
  CreateDnsDomainSchema,
  CreateDnsRecordSchema,
  DnsDomainSchema,
  DnsRecordListQuerySchema,
  DnsRecordSchema,
  UpdateDnsDomainSchema,
  UpdateDnsRecordSchema,
} from '../schemas/dns-records';
import { ErrorResponseSchema } from '../schemas/responses';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses, authedRoleGatedErrorResponses } from './responses';

const c = initContract();

export const dnsRecordsRoutes = c.router({
  listDnsDomains: {
    method: 'GET',
    path: '/zones/:zoneId/dns/domains',
    pathParams: z.object({ zoneId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: z.array(DnsDomainSchema),
      404: ErrorResponseSchema,
    },
    summary: 'List DNS domains for a zone',
    description: 'Returns all DNS domains (forward and reverse) belonging to the specified zone.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  createDnsDomain: {
    method: 'POST',
    path: '/zones/:zoneId/dns/domains',
    pathParams: z.object({ zoneId: z.string() }),
    body: CreateDnsDomainSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      201: DnsDomainSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Create a DNS domain',
    description: 'Creates a new DNS domain within the specified zone. Domain names must be unique per zone.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  getDnsDomain: {
    method: 'GET',
    path: '/zones/:zoneId/dns/domains/:domainId',
    pathParams: z.object({ zoneId: z.string(), domainId: z.string() }),
    responses: {
      ...authedErrorResponses,
      200: DnsDomainSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get a DNS domain by ID',
    description: 'Returns the DNS domain with the specified ID within the zone.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  updateDnsDomain: {
    method: 'PUT',
    path: '/zones/:zoneId/dns/domains/:domainId',
    pathParams: z.object({ zoneId: z.string(), domainId: z.string() }),
    body: UpdateDnsDomainSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: DnsDomainSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Update a DNS domain',
    description: 'Updates the name of a DNS domain. Domain names must remain unique within the zone.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  deleteDnsDomain: {
    method: 'DELETE',
    path: '/zones/:zoneId/dns/domains/:domainId',
    pathParams: z.object({ zoneId: z.string(), domainId: z.string() }),
    responses: {
      ...authedRoleGatedErrorResponses,
      204: z.void(),
      404: ErrorResponseSchema,
    },
    summary: 'Delete a DNS domain',
    description:
      'Soft-deletes a DNS domain and all of its records from the zone. Records are marked as deleted rather than removed.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  listDnsRecords: {
    method: 'GET',
    path: '/zones/:zoneId/dns/domains/:domainId/records',
    pathParams: z.object({ zoneId: z.string(), domainId: z.string() }),
    query: DnsRecordListQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: z.array(DnsRecordSchema),
      404: ErrorResponseSchema,
    },
    summary: 'List DNS records for a domain',
    description:
      'Returns all DNS records belonging to the specified domain. Optionally filter by source (MANUAL or AUTO).',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  createDnsRecord: {
    method: 'POST',
    path: '/zones/:zoneId/dns/domains/:domainId/records',
    pathParams: z.object({ zoneId: z.string(), domainId: z.string() }),
    body: CreateDnsRecordSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      201: DnsRecordSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Create a manual DNS record',
    description:
      'Creates a new manual DNS record within the specified domain. Only manual records can be created via the API. Duplicate name+type+value combinations are rejected.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  updateDnsRecord: {
    method: 'PUT',
    path: '/zones/:zoneId/dns/domains/:domainId/records/:recordId',
    pathParams: z.object({ zoneId: z.string(), domainId: z.string(), recordId: z.string() }),
    body: UpdateDnsRecordSchema,
    responses: {
      ...authedRoleGatedErrorResponses,
      200: DnsRecordSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
      409: ErrorResponseSchema,
    },
    summary: 'Update a manual DNS record',
    description:
      'Updates an existing manual DNS record. Only manual records can be modified via the API. Auto-derived records are managed by the system.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },

  deleteDnsRecord: {
    method: 'DELETE',
    path: '/zones/:zoneId/dns/domains/:domainId/records/:recordId',
    pathParams: z.object({ zoneId: z.string(), domainId: z.string(), recordId: z.string() }),
    responses: {
      ...authedRoleGatedErrorResponses,
      204: z.void(),
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Delete a manual DNS record',
    description: 'Soft-deletes a DNS record. Only manual records can be deleted through this endpoint.',
    metadata: { visibility: 'public' } as RouteMetadata,
  },
});
