import {
  DEVICE_HEALTH_RECORDED,
  DEVICE_METADATA_UPDATED,
  DeviceHealthRecordedFrameSchema,
  DeviceMetadataUpdatedFrameSchema,
  JOB_EVENT_RECORDED,
  JobEventRecordedFrameSchema,
  type DeviceEventFrame,
} from '@repo/api-client';
import { z } from 'zod';

export const SSE_CHANNEL = 'sse:device-metadata-updated';

// organizationId is the active customer; supplierId is the owner. Either org may subscribe; neither field reaches the wire.
const scope = {
  organizationId: z.string().nullable(),
  supplierId: z.string().nullable(),
};

export const DeviceMetadataUpdatedEventSchema = DeviceMetadataUpdatedFrameSchema.extend(scope);
export type DeviceMetadataUpdatedEvent = z.infer<typeof DeviceMetadataUpdatedEventSchema>;

export const JobEventRecordedEventSchema = JobEventRecordedFrameSchema.extend(scope);
export type JobEventRecordedEvent = z.infer<typeof JobEventRecordedEventSchema>;

export const DeviceHealthRecordedEventSchema = DeviceHealthRecordedFrameSchema.extend(scope);
export type DeviceHealthRecordedEvent = z.infer<typeof DeviceHealthRecordedEventSchema>;

export const DeviceEventSchema = z.discriminatedUnion('type', [
  DeviceMetadataUpdatedEventSchema,
  JobEventRecordedEventSchema,
  DeviceHealthRecordedEventSchema,
]);
export type DeviceEvent = z.infer<typeof DeviceEventSchema>;

export interface EventViewer {
  organizationId: string | null;
  /** job:read on the instance operator organization; a renting organization sees only the job frames it requested. */
  canReadJobs: boolean;
}

export function eventVisibleTo(event: DeviceEvent, viewer: EventViewer): boolean {
  if (event.type === JOB_EVENT_RECORDED) {
    return viewer.canReadJobs || (event.organizationId !== null && event.organizationId === viewer.organizationId);
  }
  if (viewer.organizationId === null) return true;
  return event.organizationId === viewer.organizationId || event.supplierId === viewer.organizationId;
}

/** The client frame: every field except the two scoping org ids. Exhaustive over the union. */
export function toWire(event: DeviceEvent): DeviceEventFrame {
  switch (event.type) {
    case DEVICE_METADATA_UPDATED:
      return {
        type: event.type,
        deviceId: event.deviceId,
        deploymentId: event.deploymentId,
        status: event.status,
        powerStatus: event.powerStatus,
      };
    case JOB_EVENT_RECORDED:
      return {
        type: event.type,
        deviceId: event.deviceId,
        deploymentId: event.deploymentId,
        jobId: event.jobId,
        phase: event.phase,
      };
    case DEVICE_HEALTH_RECORDED:
      return {
        type: event.type,
        deviceId: event.deviceId,
        healthCheckId: event.healthCheckId,
        testedAt: event.testedAt,
      };
  }
}
