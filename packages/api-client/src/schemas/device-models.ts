import { z } from 'zod';

export const DeviceModelSchema = z.object({
  id: z.string().uuid().describe('Device model UUID'),
  manufacturer: z.string().describe('Hardware manufacturer name'),
  model: z.string().describe('Hardware model name'),
  formFactor: z.string().nullable().describe('Physical form factor (e.g. 1U, 2U, blade)'),
  description: z.string().nullable().describe('Device model description'),
  isFullDepth: z.boolean().describe('Whether the device occupies the full depth of a rack'),
  heightU: z.number().int().nullable().describe('Height in rack units'),
  maxPowerW: z.number().int().nullable().describe('Maximum power draw in watts'),
  createdAt: z.coerce.date().describe('Creation timestamp'),
  updatedAt: z.coerce.date().describe('Last update timestamp'),
});
export type DeviceModel = z.infer<typeof DeviceModelSchema>;

export const CreateDeviceModelRequestSchema = z.object({
  manufacturer: z.string().min(1).describe('Hardware manufacturer name'),
  model: z.string().min(1).describe('Hardware model name'),
  formFactor: z.string().nullable().optional().describe('Physical form factor (e.g. 1U, 2U, blade)'),
  description: z.string().trim().nullable().optional().describe('Device model description'),
  isFullDepth: z.boolean().optional().describe('Whether the device occupies the full depth of a rack'),
  heightU: z.number().int().nullable().optional().describe('Height in rack units'),
  maxPowerW: z.number().int().nullable().optional().describe('Maximum power draw in watts'),
});
export type CreateDeviceModelRequest = z.infer<typeof CreateDeviceModelRequestSchema>;

export const UpdateDeviceModelRequestSchema = z.object({
  manufacturer: z.string().min(1).optional().describe('Hardware manufacturer name'),
  model: z.string().min(1).optional().describe('Hardware model name'),
  formFactor: z.string().nullable().optional().describe('Physical form factor (e.g. 1U, 2U, blade)'),
  description: z.string().trim().nullable().optional().describe('Device model description'),
  isFullDepth: z.boolean().optional().describe('Whether the device occupies the full depth of a rack'),
  heightU: z.number().int().nullable().optional().describe('Height in rack units'),
  maxPowerW: z.number().int().nullable().optional().describe('Maximum power draw in watts'),
});
export type UpdateDeviceModelRequest = z.infer<typeof UpdateDeviceModelRequestSchema>;

export const DeviceModelListQuerySchema = z.object({
  manufacturer: z.string().optional().describe('Filter by manufacturer name'),
});
export type DeviceModelListQuery = z.infer<typeof DeviceModelListQuerySchema>;
