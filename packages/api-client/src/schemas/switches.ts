import { z } from 'zod';
import { BooleanQueryParamSchema } from './common';
import { PaginationQuerySchema, createPaginatedResponseSchema } from './pagination';

export const SwitchPowerStatusSchema = z.enum(['On', 'Off']);
export type SwitchPowerStatus = z.infer<typeof SwitchPowerStatusSchema>;

export const SwitchSchema = z.object({
  deviceId: z.string().uuid().describe('Device UUID — the identifier for the Switch-role device.'),
  name: z.string().describe('Device hostname.'),
  nickname: z.string().nullable().describe('Operator-supplied display nickname.'),
  status: z.string().describe('Coarse device lifecycle status (e.g. ACTIVE, MAINTENANCE).'),
  powerStatus: SwitchPowerStatusSchema.nullable().describe('Observed power state; null when never reported.'),
  switchRole: z.string().nullable().describe('Fabric role: leaf, spine, management, or serial-console.'),
  fabric: z.string().nullable().describe('Fabric the switch belongs to: east-west or north-south.'),
  portCount: z.number().int().nullable().describe('Physical port count on the chassis.'),
  zoneId: z.string().uuid().nullable().describe('Zone (data center) UUID the switch sits in.'),
  zoneName: z.string().nullable().describe('Zone (data center) display name.'),
  supplierId: z.string().uuid().nullable().describe('Owning supplier organization UUID (tenant scope).'),
  supplierName: z.string().nullable().describe('Owning supplier organization name.'),
  deletedAt: z.coerce
    .date()
    .nullable()
    .describe('Decommissioning marker — non-null means the switch has been decommissioned (soft-deleted).'),
  createdAt: z.coerce.date().describe('Creation timestamp.'),
  updatedAt: z.coerce.date().describe('Last update timestamp.'),
});
export type Switch = z.infer<typeof SwitchSchema>;

export const UpdateSwitchRequestSchema = z.object({
  nickname: z.string().trim().min(1).nullable().optional().describe('Operator-supplied display nickname.'),
  switchRole: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe('Fabric role: leaf, spine, management, or serial-console.'),
  fabric: z
    .string()
    .trim()
    .min(1)
    .nullable()
    .optional()
    .describe('Fabric the switch belongs to: east-west or north-south.'),
  portCount: z.number().int().min(0).nullable().optional().describe('Physical port count on the chassis.'),
  powerStatus: SwitchPowerStatusSchema.nullable().optional().describe('Observed power state.'),
});
export type UpdateSwitchRequest = z.infer<typeof UpdateSwitchRequestSchema>;

export const SwitchesQuerySchema = PaginationQuerySchema.extend({
  zoneId: z.string().uuid().optional().describe('Filter by zone (data center) UUID.'),
  decommissioned: BooleanQueryParamSchema.optional().describe(
    'When true, list decommissioned (soft-deleted) switches instead.',
  ),
});
export type SwitchesQuery = z.infer<typeof SwitchesQuerySchema>;

export const SwitchListResponseSchema = createPaginatedResponseSchema(SwitchSchema);
export type SwitchListResponse = z.infer<typeof SwitchListResponseSchema>;
