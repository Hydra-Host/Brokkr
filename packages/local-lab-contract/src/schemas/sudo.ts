import { z } from 'zod';

export const SudoStatusSchema = z.object({
  available: z.boolean().describe('True if sudo can run without a prompt (passwordless or cached)'),
});
