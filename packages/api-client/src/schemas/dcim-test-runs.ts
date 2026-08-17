import { z } from 'zod';
import { DeviceTestRunResponseSchema, DeviceTestStatusSchema, DeviceTestTypeSchema } from './bridge';
import { PaginationQuerySchema, createPaginatedResponseSchema } from './pagination';

export const DcimDeviceTestRunWithDeviceSchema = DeviceTestRunResponseSchema.extend({
  device: z
    .object({
      id: z.string().uuid().describe('Device UUID'),
      name: z.string().describe('Device name'),
      gpuModel: z.string().nullable().describe('GPU model installed in the device'),
    })
    .nullable()
    .optional()
    .describe('Device snapshot at test time'),
});

export const DcimDeviceTestRunsQuerySchema = PaginationQuerySchema.extend({
  deviceId: z.string().uuid().optional().describe('Filter test runs by a specific device UUID'),
  type: DeviceTestTypeSchema.optional().describe('Filter by test type (GpuBurnIn or NcclPerformance)'),
  status: DeviceTestStatusSchema.optional().describe('Filter by test status (Running or Completed)'),
});

export const DcimDeviceTestRunsListResponseSchema = createPaginatedResponseSchema(DcimDeviceTestRunWithDeviceSchema);

export type DcimDeviceTestRunWithDevice = z.infer<typeof DcimDeviceTestRunWithDeviceSchema>;
export type DcimDeviceTestRunsQuery = z.infer<typeof DcimDeviceTestRunsQuerySchema>;
export type DcimDeviceTestRunsListResponse = z.infer<typeof DcimDeviceTestRunsListResponseSchema>;
