import { z } from 'zod';

export const serverTokenAtomSchema = z
  .object({
    brokkr_live_token: z.string().min(1),
    endpoint: z.string().min(1),
    exp: z.number().int(),
  })
  .strict();

export type ServerTokenAtom = z.infer<typeof serverTokenAtomSchema>;
