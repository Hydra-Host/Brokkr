import { Airflow, CduPowerStatus } from '@repo/database/enums';
import { z } from 'zod';
import { BooleanQueryParamSchema } from './common';
import { PaginationQuerySchema, createPaginatedResponseSchema } from './pagination';
import { zodEnumFromPrisma } from './prisma-enum';

export const CduPowerStatusSchema = zodEnumFromPrisma(CduPowerStatus);
export type { CduPowerStatus };

export const AirflowSchema = zodEnumFromPrisma(Airflow);
export type { Airflow };

export const CduSchema = z.object({
  deviceId: z.string().uuid().describe('Device UUID — the identifier for the CDU-role device.'),
  name: z.string().describe('Device hostname.'),
  nickname: z.string().nullable().describe('Operator-supplied display nickname.'),
  status: z.string().describe('Coarse device lifecycle status (e.g. ACTIVE, MAINTENANCE).'),
  powerStatus: CduPowerStatusSchema.nullable().describe('Observed power state; null when never reported.'),
  coolantType: z.string().nullable().describe('Coolant medium (e.g. water, glycol, refrigerant).'),
  ratedFlowRateLpm: z.number().nullable().describe('Rated coolant flow at design conditions (liters per minute).'),
  ratedThermalCapacityKw: z.number().int().nullable().describe('Rated heat-rejection capacity in kilowatts.'),
  airflow: AirflowSchema.describe('Direction air/coolant moves through the unit.'),
  zoneId: z.string().uuid().nullable().describe('Zone (data center) UUID the CDU sits in.'),
  zoneName: z.string().nullable().describe('Zone (data center) display name.'),
  supplierId: z.string().uuid().nullable().describe('Owning supplier organization UUID (tenant scope).'),
  supplierName: z.string().nullable().describe('Owning supplier organization name.'),
  deletedAt: z.coerce
    .date()
    .nullable()
    .describe('Decommissioning marker — non-null means the CDU has been decommissioned (soft-deleted).'),
  createdAt: z.coerce.date().describe('Creation timestamp.'),
  updatedAt: z.coerce.date().describe('Last update timestamp.'),
});
export type Cdu = z.infer<typeof CduSchema>;

export const UpdateCduRequestSchema = z.object({
  nickname: z.string().trim().min(1).nullable().optional().describe('Operator-supplied display nickname.'),
  coolantType: z.string().trim().nullable().optional().describe('Coolant medium (e.g. water, glycol).'),
  ratedFlowRateLpm: z.number().min(0).nullable().optional().describe('Rated coolant flow (liters per minute).'),
  ratedThermalCapacityKw: z.number().int().min(0).nullable().optional().describe('Rated heat-rejection capacity (kW).'),
  airflow: AirflowSchema.optional().describe('Direction air/coolant moves through the unit.'),
  powerStatus: CduPowerStatusSchema.nullable().optional().describe('Observed power state.'),
});
export type UpdateCduRequest = z.infer<typeof UpdateCduRequestSchema>;

export const CdusQuerySchema = PaginationQuerySchema.extend({
  zoneId: z.string().uuid().optional().describe('Filter by zone (data center) UUID.'),
  decommissioned: BooleanQueryParamSchema.optional().describe(
    'When true, list decommissioned (soft-deleted) CDUs instead.',
  ),
});
export type CdusQuery = z.infer<typeof CdusQuerySchema>;

export const CduListResponseSchema = createPaginatedResponseSchema(CduSchema);
export type CduListResponse = z.infer<typeof CduListResponseSchema>;
