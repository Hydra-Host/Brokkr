import { initContract } from '@ts-rest/core';
import { z } from 'zod';
import { ErrorResponseSchema } from '../schemas/index';
import {
  CategoryAvailabilitySchema,
  CategoryPriceSchema,
  InventoryListingSchema,
  InventoryListingsQuerySchema,
  ProvisionRequestSchema,
  ProvisionResponseSchema,
  RegionSchema,
} from '../schemas/inventory';
import { PaginationQuerySchema, createPaginatedResponseSchema } from '../schemas/pagination';
import { type RouteMetadata } from './metadata';
import { authedErrorResponses } from './responses';

const c = initContract();

export const inventoryRoutes = c.router({
  getInventory: {
    method: 'GET',
    path: '/inventory',
    query: InventoryListingsQuerySchema,
    responses: {
      200: createPaginatedResponseSchema(InventoryListingSchema),
    },
    summary: 'Get paginated inventory listings with optional filters',
    description:
      'Returns a paginated list of available devices for provisioning. Supports filtering by GPU category, region, and stock status.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getRegions: {
    method: 'GET',
    path: '/inventory/regions',
    query: PaginationQuerySchema,
    responses: {
      ...authedErrorResponses,
      200: createPaginatedResponseSchema(RegionSchema),
    },
    summary: 'Get all available regions',
    description: 'Returns a paginated list of all data center regions where devices are available.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getCategoryPrices: {
    method: 'GET',
    path: '/inventory/category-prices',
    query: PaginationQuerySchema,
    responses: {
      200: createPaginatedResponseSchema(CategoryPriceSchema),
    },
    summary: 'Get starting prices for all GPU categories',
    description: 'Returns the lowest available starting price for each GPU or compute device category.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getCategoryAvailability: {
    method: 'GET',
    path: '/inventory/category-availability',
    query: PaginationQuerySchema,
    responses: {
      200: createPaginatedResponseSchema(CategoryAvailabilitySchema),
    },
    summary: 'Get on-demand availability for all GPU categories',
    description:
      'Returns whether each GPU or compute device category has on-demand stock currently available, along with a count of available devices.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  getInventoryById: {
    method: 'GET',
    path: '/inventory/:id',
    pathParams: z.object({
      id: z.string().uuid(),
    }),
    responses: {
      ...authedErrorResponses,
      200: InventoryListingSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Get inventory item by device ID',
    description:
      'Returns full details for a single inventory listing, including specs, pricing, available OS images, and storage layouts.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },

  provisionDevice: {
    method: 'PATCH',
    path: '/inventory/:id/provision',
    pathParams: z.object({
      id: z.string().uuid(),
    }),
    body: ProvisionRequestSchema,
    responses: {
      ...authedErrorResponses,
      200: ProvisionResponseSchema,
      400: ErrorResponseSchema,
      404: ErrorResponseSchema,
    },
    summary: 'Provision device by device ID',
    description:
      'Provisions an available device with the specified OS, SSH keys, disk layout, and contract type. Creates a new deployment for the organization.',
    metadata: { visibility: 'public' } satisfies RouteMetadata,
  },
});
