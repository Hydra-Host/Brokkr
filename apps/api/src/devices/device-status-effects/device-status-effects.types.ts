import { z } from 'zod';
import { StatusTransitionType } from './transitions';

export const DEVICE_STATUS_EFFECTS_QUEUE = 'device-status-effects';

export const STATUS_TRANSITION_JOB = 'status-transition';

export const StatusTransitionJobSchema = z.object({
  deviceId: z.string().uuid().describe('UUID of the Device whose status changed.'),
  transition: z
    .nativeEnum(StatusTransitionType)
    .describe('The named transition that fired (drives which notification handler runs).'),
  fromStatus: z.string().nullable().describe('Prior DeviceStatus value (informational; for logging only).'),
  toStatus: z.string().nullable().describe('New DeviceStatus value (informational; for logging only).'),
});

export type StatusTransitionJob = z.infer<typeof StatusTransitionJobSchema>;
