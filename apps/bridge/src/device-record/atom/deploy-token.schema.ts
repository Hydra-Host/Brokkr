import { z } from 'zod';

export const deployTokenAtomSchema = z
  .object({
    deployment_os_token: z.string().min(1),
    endpoint: z.string().min(1),
  })
  .strict();

export type DeployTokenAtom = z.infer<typeof deployTokenAtomSchema>;
