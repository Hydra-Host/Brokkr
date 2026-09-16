import { z } from 'zod';

const treeSegment = z.string().regex(/^[A-Za-z0-9._-]+$/);

const ArchInvSchema = z.object({
  flavor: treeSegment,
  arch: treeSegment,
  files: z.array(
    z.object({
      name: z.string(),
      present: z.boolean(),
      sizeBytes: z.number().int().nonnegative(),
      mtimeMs: z.number().int().nonnegative(),
    }),
  ),
});

/** The bridge's `GET /api/discovery/inventory` response, restated because the lab imports neither app. */
export const DiscoveryInventorySchema = z.object({ architectures: z.array(ArchInvSchema) });

export type ArchInv = z.infer<typeof ArchInvSchema>;
