import { RouterPowerStatus } from '@repo/database/enums';
import { z } from 'zod';
import { BooleanQueryParamSchema } from './common';
import { PaginationQuerySchema, createPaginatedResponseSchema } from './pagination';
import { zodEnumFromPrisma } from './prisma-enum';

export const RouterPowerStatusSchema = zodEnumFromPrisma(RouterPowerStatus);
export type { RouterPowerStatus };

export const RouterSchema = z.object({
  deviceId: z.string().uuid().describe('Device UUID — the identifier for the Router-role device.'),
  name: z.string().describe('Device hostname.'),
  nickname: z.string().nullable().describe('Operator-supplied display nickname.'),
  status: z.string().describe('Coarse device lifecycle status (e.g. ACTIVE, MAINTENANCE).'),
  powerStatus: RouterPowerStatusSchema.nullable().describe('Observed power state; null when never reported.'),
  routerType: z.string().nullable().describe('Router type: edge, core, border, or internal.'),
  bgpAsn: z.number().int().nullable().describe('BGP autonomous system number this router announces from.'),
  zoneId: z.string().uuid().nullable().describe('Zone (data center) UUID the router sits in.'),
  zoneName: z.string().nullable().describe('Zone (data center) display name.'),
  supplierId: z.string().uuid().nullable().describe('Owning supplier organization UUID (tenant scope).'),
  supplierName: z.string().nullable().describe('Owning supplier organization name.'),
  deletedAt: z.coerce
    .date()
    .nullable()
    .describe('Decommissioning marker — non-null means the router has been decommissioned (soft-deleted).'),
  createdAt: z.coerce.date().describe('Creation timestamp.'),
  updatedAt: z.coerce.date().describe('Last update timestamp.'),
});
export type Router = z.infer<typeof RouterSchema>;

export const UpdateRouterRequestSchema = z.object({
  nickname: z.string().trim().min(1).nullable().optional().describe('Operator-supplied display nickname.'),
  routerType: z.string().trim().min(1).nullable().optional().describe('Router type: edge, core, border, or internal.'),
  bgpAsn: z
    .number()
    .int()
    .min(1)
    .max(2147483647)
    .nullable()
    .optional()
    .describe('BGP autonomous system number this router announces from.'),
  powerStatus: RouterPowerStatusSchema.nullable().optional().describe('Observed power state.'),
});
export type UpdateRouterRequest = z.infer<typeof UpdateRouterRequestSchema>;

export const RoutersQuerySchema = PaginationQuerySchema.extend({
  zoneId: z.string().uuid().optional().describe('Filter by zone (data center) UUID.'),
  decommissioned: BooleanQueryParamSchema.optional().describe(
    'When true, list decommissioned (soft-deleted) routers instead.',
  ),
});
export type RoutersQuery = z.infer<typeof RoutersQuerySchema>;

export const RouterListResponseSchema = createPaginatedResponseSchema(RouterSchema);
export type RouterListResponse = z.infer<typeof RouterListResponseSchema>;
