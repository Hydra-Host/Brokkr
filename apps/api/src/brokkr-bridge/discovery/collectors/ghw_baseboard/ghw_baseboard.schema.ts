import { z } from 'zod';
import { hardwareString } from '../hardware-string';

export const ghwBaseboardSchema = z
  .object({
    baseboard: z
      .object({
        asset_tag: hardwareString(),
        serial_number: hardwareString(),
        vendor: hardwareString(),
        version: hardwareString(),
        product: hardwareString(),
      })
      .passthrough(),
  })
  .passthrough();

export type GhwBaseboardInput = z.infer<typeof ghwBaseboardSchema>;
