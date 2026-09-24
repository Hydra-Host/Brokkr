import { z } from 'zod';

export const DEVICE_METADATA_UPDATED = 'device.metadata.updated';
export const JOB_EVENT_RECORDED = 'job.event.recorded';
export const DEVICE_HEALTH_RECORDED = 'device.health.recorded';

const deviceId = z.string().describe('Device the event is about');

export const DeviceMetadataUpdatedFrameSchema = z.object({
  type: z.literal(DEVICE_METADATA_UPDATED).describe('Event kind'),
  deviceId,
  deploymentId: z.string().nullable().describe('Active deployment on the device; null when none'),
  status: z.string().nullable().describe('Device status after the change; null when unknown'),
  powerStatus: z.string().nullable().describe('Power status after the change; null when unknown'),
});

export const JobEventRecordedFrameSchema = z.object({
  type: z.literal(JOB_EVENT_RECORDED).describe('Event kind'),
  deviceId,
  deploymentId: z.string().nullable().describe('Deployment the job targets; null for a device-only job'),
  jobId: z.string().describe('Lifecycle job that recorded a step event'),
  phase: z
    .string()
    .nullable()
    .describe('Engine phase the publisher reported with the event; informational, for cache invalidation'),
});

export const DeviceHealthRecordedFrameSchema = z.object({
  type: z.literal(DEVICE_HEALTH_RECORDED).describe('Event kind'),
  deviceId,
  healthCheckId: z.string().describe('Health check row the bridge result produced'),
  testedAt: z.string().describe('ISO 8601 time the change was recorded'),
});

export const DeviceEventFrameSchema = z
  .discriminatedUnion('type', [
    DeviceMetadataUpdatedFrameSchema,
    JobEventRecordedFrameSchema,
    DeviceHealthRecordedFrameSchema,
  ])
  .describe('One frame on the device event stream');
export type DeviceEventFrame = z.infer<typeof DeviceEventFrameSchema>;
