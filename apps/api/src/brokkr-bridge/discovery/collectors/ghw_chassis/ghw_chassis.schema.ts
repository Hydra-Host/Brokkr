import { z } from 'zod';
import { hardwareString } from '../hardware-string';

export const ghwChassisSchema = z
  .object({
    chassis: z
      .object({
        asset_tag: hardwareString(),
        serial_number: hardwareString(),
        type: z.string().optional(),
        type_description: z.string().optional(),
        vendor: hardwareString(),
        version: hardwareString(),
      })
      .passthrough(),
  })
  .passthrough();

export type GhwChassisInput = z.infer<typeof ghwChassisSchema>;
