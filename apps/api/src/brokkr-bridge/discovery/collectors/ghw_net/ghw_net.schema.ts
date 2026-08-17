import { z } from 'zod';

const nicSchema = z
  .object({
    name: z.string().min(1),
    mac_address: z.string().optional().default(''),
    is_virtual: z.boolean().optional().default(false),
    speed: z.string().optional().default(''),
    duplex: z.string().optional().default(''),
  })
  .passthrough();

export const ghwNetSchema = z
  .object({
    network: z
      .object({
        nics: z.array(z.unknown()),
      })
      .passthrough(),
  })
  .passthrough();

export { nicSchema as ghwNetNicSchema };
export type GhwNetInput = z.infer<typeof ghwNetSchema>;
