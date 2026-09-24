export { DEVICE_HEALTH_RECORDED, DEVICE_METADATA_UPDATED, JOB_EVENT_RECORDED } from '@repo/api-client';
export {
  DeviceEventSchema,
  DeviceHealthRecordedEventSchema,
  DeviceMetadataUpdatedEventSchema,
  JobEventRecordedEventSchema,
  eventVisibleTo,
  toWire,
  type DeviceEvent,
  type DeviceHealthRecordedEvent,
  type DeviceMetadataUpdatedEvent,
  type EventViewer,
  type JobEventRecordedEvent,
} from '@repo/device-domain';
