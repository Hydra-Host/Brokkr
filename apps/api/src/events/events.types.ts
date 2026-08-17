import { z } from 'zod';

export const DEVICE_METADATA_UPDATED = 'device.metadata.updated';

export const DeviceMetadataUpdatedEventSchema = z.object({
  deviceId: z.string(),
  deploymentId: z.string().nullable(),
  organizationId: z.string().nullable(),
  status: z.string().nullable(),
  powerStatus: z.string().nullable(),
});

export type DeviceMetadataUpdatedEvent = z.infer<typeof DeviceMetadataUpdatedEventSchema>;
