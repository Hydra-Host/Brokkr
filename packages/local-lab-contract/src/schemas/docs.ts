import { z } from 'zod';

export const GettingStartedSchema = z.object({
  markdown: z.string().describe('Raw getting-started.md contents (CommonMark/GFM)'),
  source: z
    .string()
    .describe('Resolved file path it was read from, or "fallback" when the bundled placeholder is used'),
  found: z.boolean().describe('True when the repo getting-started.md was read; false = bundled placeholder'),
});
export type GettingStarted = z.infer<typeof GettingStartedSchema>;
