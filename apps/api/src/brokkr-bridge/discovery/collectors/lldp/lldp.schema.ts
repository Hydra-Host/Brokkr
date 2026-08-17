import { z } from 'zod';

export const lldpSchema = z
  .object({
    lldp: z
      .object({
        interface: z.union([z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type LldpInput = z.infer<typeof lldpSchema>;
