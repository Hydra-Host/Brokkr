import { z } from 'zod';

export const publicIpSchema = z
  .object({
    ipv4: z.string().nullish(),
    ipv6: z.string().nullish(),
    check_url: z.string().nullish(),
  })
  .passthrough();

export type PublicIpInput = z.infer<typeof publicIpSchema>;
