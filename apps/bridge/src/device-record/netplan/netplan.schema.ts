import { z } from 'zod';

export const netplanAtomSchema = z
  .object({
    yaml: z.string().min(1),
  })
  .strict();

export type NetplanAtom = z.infer<typeof netplanAtomSchema>;
