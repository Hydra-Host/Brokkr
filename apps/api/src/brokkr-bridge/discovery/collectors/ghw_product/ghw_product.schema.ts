import { z } from 'zod';
import { hardwareString } from '../hardware-string';

export const ghwProductSchema = z
  .object({
    product: z
      .object({
        family: hardwareString(),
        name: hardwareString(),
        vendor: hardwareString(),
        serial_number: hardwareString(),
        uuid: z.string().uuid().optional(),
        sku: hardwareString(),
        version: hardwareString(),
      })
      .passthrough(),
  })
  .passthrough();

export type GhwProductInput = z.infer<typeof ghwProductSchema>;
