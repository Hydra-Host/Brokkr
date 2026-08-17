import { z } from 'zod';

export const bmcSchema = z
  .object({
    ipv4: z.string().min(1).nullable(),
    mac: z.string().min(1).nullable(),
    ipv6: z.string().nullable().optional(),
  })
  .passthrough();

export type BmcInput = z.infer<typeof bmcSchema>;
