import { z } from 'zod';
import { hardwareString } from '../hardware-string';

export const ghwBiosSchema = z
  .object({
    bios: z
      .object({
        vendor: hardwareString(),
        version: z.string().min(1),
        date: hardwareString(),
      })
      .passthrough(),
  })
  .passthrough();

export type GhwBiosInput = z.infer<typeof ghwBiosSchema>;
