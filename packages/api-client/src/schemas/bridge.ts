import { DeviceTestStatus, DeviceTestType } from '@repo/database/enums';
import { z } from 'zod';
import { zodEnumFromPrisma } from './prisma-enum';

export const DeviceTestTypeSchema = zodEnumFromPrisma(DeviceTestType).describe(
  'Type of hardware test to run on a device',
);
export type DeviceTestTypeEnum = DeviceTestType;

export const DeviceTestStatusSchema = zodEnumFromPrisma(DeviceTestStatus).describe(
  'Current execution status of a device test run',
);
export type DeviceTestStatusEnum = DeviceTestStatus;

export const CreateDeviceTestRunRequestSchema = z.object({
  deviceId: z.string().uuid().describe('Device UUID to run the test on'),
  type: DeviceTestTypeSchema.describe('Type of test to execute'),
});

export type CreateDeviceTestRunRequest = z.infer<typeof CreateDeviceTestRunRequestSchema>;

export const UpdateDeviceTestRunRequestSchema = z.object({
  status: z.literal('Completed').describe('Final status of the test run (must be "Completed")'),
  testPassed: z.boolean().describe('Whether the test passed or failed'),
  data: z.record(z.unknown()).describe('Test result data containing metrics and details'),
});

export type UpdateDeviceTestRunRequest = z.infer<typeof UpdateDeviceTestRunRequestSchema>;

export const DeviceTestRunResponseSchema = z.object({
  id: z.string().describe('Unique identifier for the test run'),
  deviceId: z.string().uuid().describe('Device UUID the test was run on'),
  type: DeviceTestTypeSchema.describe('Type of test that was executed'),
  status: DeviceTestStatusSchema.describe('Current status of the test run'),
  startTime: z.string().describe('ISO 8601 timestamp when the test started'),
  endTime: z.string().nullable().describe('ISO 8601 timestamp when the test ended, or null if still running'),
  durationSeconds: z.number().nullable().describe('Total test duration in seconds, or null if still running'),
  testPassed: z.boolean().nullable().describe('Whether the test passed, or null if still running'),
  data: z.unknown().nullable().describe('Test result data payload, or null if not yet available'),
  createdAt: z.string().describe('ISO 8601 timestamp when the record was created'),
  updatedAt: z.string().describe('ISO 8601 timestamp when the record was last updated'),
});

export type DeviceTestRunResponse = z.infer<typeof DeviceTestRunResponseSchema>;
