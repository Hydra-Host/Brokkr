import { z } from 'zod';

const fileInventorySchema = z.object({
  name: z.string().describe('Required discovery filename (relative segment only, no path)'),
  present: z.boolean().describe('Whether the file exists in the served brokkr-live/<arch> dir'),
  sizeBytes: z.number().int().nonnegative().describe('File size in bytes; 0 when absent'),
  mtimeMs: z.number().int().nonnegative().describe('Last-modified epoch ms; 0 when absent'),
});

const archInventorySchema = z.object({
  arch: z.string().describe('Discovery architecture segment (e.g. arm64, amd64)'),
  files: z.array(fileInventorySchema).describe('Per-required-file presence/size/mtime for this arch'),
});

export const discoveryInventoryResponseSchema = z.object({
  architectures: z.array(archInventorySchema).describe('Inventory per served DISCOVERY_ARCHITECTURES entry'),
});

export type DiscoveryInventoryResponse = z.infer<typeof discoveryInventoryResponseSchema>;
