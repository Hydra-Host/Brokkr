import { PduPowerStatus } from '@repo/database/enums';
import { z } from 'zod';
import { BooleanQueryParamSchema } from './common';
import { PaginationQuerySchema, createPaginatedResponseSchema } from './pagination';
import { zodEnumFromPrisma } from './prisma-enum';

export const PduPowerStatusSchema = zodEnumFromPrisma(PduPowerStatus);
export type { PduPowerStatus };

export const PduSchema = z.object({
  deviceId: z.string().uuid().describe('Device UUID — the identifier for the PDU-role device.'),
  name: z.string().describe('Device hostname.'),
  nickname: z.string().nullable().describe('Operator-supplied display nickname.'),
  status: z.string().describe('Coarse device lifecycle status (e.g. ACTIVE, MAINTENANCE).'),
  powerStatus: PduPowerStatusSchema.nullable().describe('Observed power state; null when never reported.'),
  outletCount: z.number().int().nullable().describe('Total switched outlets on the unit.'),
  ratedAmperage: z.number().int().nullable().describe('Total rated amperage at the inlet.'),
  voltageType: z.string().nullable().describe('Nominal voltage class (e.g. 120V, 208V, 240V, 400V).'),
  zoneId: z.string().uuid().nullable().describe('Zone (data center) UUID the PDU sits in.'),
  zoneName: z.string().nullable().describe('Zone (data center) display name.'),
  supplierId: z.string().uuid().nullable().describe('Owning supplier organization UUID (tenant scope).'),
  supplierName: z.string().nullable().describe('Owning supplier organization name.'),
  deletedAt: z.coerce
    .date()
    .nullable()
    .describe('Decommissioning marker — non-null means the PDU has been decommissioned (soft-deleted).'),
  createdAt: z.coerce.date().describe('Creation timestamp.'),
  updatedAt: z.coerce.date().describe('Last update timestamp.'),
});
export type Pdu = z.infer<typeof PduSchema>;

export const UpdatePduRequestSchema = z.object({
  nickname: z.string().trim().min(1).nullable().optional().describe('Operator-supplied display nickname.'),
  outletCount: z.number().int().min(0).nullable().optional().describe('Total switched outlets on the unit.'),
  ratedAmperage: z.number().int().min(0).nullable().optional().describe('Total rated amperage at the inlet.'),
  voltageType: z.string().trim().nullable().optional().describe('Nominal voltage class (e.g. 120V, 208V).'),
  powerStatus: PduPowerStatusSchema.nullable().optional().describe('Observed power state.'),
});
export type UpdatePduRequest = z.infer<typeof UpdatePduRequestSchema>;

export const PdusQuerySchema = PaginationQuerySchema.extend({
  zoneId: z.string().uuid().optional().describe('Filter by zone (data center) UUID.'),
  decommissioned: BooleanQueryParamSchema.optional().describe(
    'When true, list decommissioned (soft-deleted) PDUs instead.',
  ),
});
export type PdusQuery = z.infer<typeof PdusQuerySchema>;

export const PduListResponseSchema = createPaginatedResponseSchema(PduSchema);
export type PduListResponse = z.infer<typeof PduListResponseSchema>;
