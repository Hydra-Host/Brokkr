import { z } from 'zod';

export const NetplanAtomSchema = z
  .object({
    yaml: z.string().min(1).describe('Rendered netplan YAML document, applied verbatim by the bridge.'),
  })
  .strict();
export type NetplanAtom = z.infer<typeof NetplanAtomSchema>;
