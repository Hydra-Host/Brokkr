import { DeviceDiagnosticsType } from '@repo/database/enums';
import { z } from 'zod';
import { zodEnumFromPrisma } from './prisma-enum';

export const PhoneHomeResponseSchema = z.object({
  message: z.string().describe('Human-readable response message from the phone-home handler'),
  deviceId: z.string().uuid().describe('Device UUID that phoned home'),
});

export type PhoneHomeResponse = z.infer<typeof PhoneHomeResponseSchema>;

export const DeviceDiagnosticsTypeSchema = zodEnumFromPrisma(DeviceDiagnosticsType).describe(
  'Category of device diagnostics to collect or report',
);
export type DeviceDiagnosticsTypeEnum = DeviceDiagnosticsType;

export const CreateDeviceDiagnosticsRequestSchema = z.object({
  type: DeviceDiagnosticsTypeSchema.describe('Type of diagnostics being reported'),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe('Diagnostics payload keyed by metric name; the value shape varies by diagnostics type.'),
});

export type CreateDeviceDiagnosticsRequest = z.infer<typeof CreateDeviceDiagnosticsRequestSchema>;

export const DeviceDiagnosticsResponseSchema = z.object({
  id: z.string().uuid().describe('Unique identifier for the diagnostics record'),
  deploymentId: z.string().describe('Deployment ID the diagnostics belong to'),
  type: DeviceDiagnosticsTypeSchema.describe('Category of diagnostics collected'),
  data: z.unknown().nullable().describe('Diagnostics payload data, or null if not yet populated'),
});

export type DeviceDiagnosticsResponse = z.infer<typeof DeviceDiagnosticsResponseSchema>;
