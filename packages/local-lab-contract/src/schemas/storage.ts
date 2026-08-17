import { z } from 'zod';

export const StorageCategoryIdSchema = z
  .enum(['discovery-images', 'built-artifacts', 'boot-artifacts', 'nginx-cache', 'overlays'])
  .describe('Storage category identifier');
export type StorageCategoryId = z.infer<typeof StorageCategoryIdSchema>;

export const WipeableCategoryIdSchema = z
  .enum(['discovery-images', 'built-artifacts', 'boot-artifacts'])
  .describe('Categories the storage API may wipe directly (others reuse existing ops)');
export type WipeableCategoryId = z.infer<typeof WipeableCategoryIdSchema>;

export const StorageItemSchema = z.object({
  name: z.string().describe('File name (relative segment) or per-item label'),
  present: z.boolean().describe('Whether the file exists on disk'),
  sizeBytes: z
    .number()
    .int()
    .nonnegative()
    .describe('Size in bytes (allocated blocks for sparse files); 0 when absent'),
  mtimeMs: z.number().int().nonnegative().describe('Last-modified epoch ms; 0 when absent'),
  path: z.string().describe('Resolved local filesystem path (host-side dev tooling)'),
  arch: z.string().optional().describe('Architecture segment for arch-scoped items (discovery/boot)'),
  sha256: z.string().optional().describe('sha256 from the spoke cache metadata, when known'),
  served: z.boolean().optional().describe('Whether the spoke returns HTTP 200 for this file (discovery only)'),
});
export type StorageItem = z.infer<typeof StorageItemSchema>;

export const StorageCategorySchema = z.object({
  id: StorageCategoryIdSchema,
  label: z.string().describe('Human label for the category card'),
  present: z.boolean().describe('Whether any files/dirs exist for this category'),
  sizeBytes: z.number().int().nonnegative().describe('Total size in bytes (allocated blocks for sparse overlays)'),
  fileCount: z.number().int().nonnegative().describe('Number of files counted for this category'),
  mtimeMs: z.number().int().nonnegative().describe('Newest mtime across the category, epoch ms; 0 when empty'),
  wipeable: z.boolean().describe('Whether POST /api/storage/wipe accepts this category'),
  detail: z.string().describe('One-line human status (e.g. missing arches, blob count)'),
  path: z.string().describe('Resolved base directory for the category'),
  items: z.array(StorageItemSchema).describe('Per-file drill-down; empty for categories without detail'),
});
export type StorageCategory = z.infer<typeof StorageCategorySchema>;

export const DiscoveryProvenanceSchema = z.object({
  version: z.string().describe('brokkr-live version being synced (BROKKR_LIVE_VERSION)'),
  originHost: z.string().describe('Origin host parsed from DISCOVERY_BASE_URL'),
  architectures: z.array(z.string()).describe('Configured DISCOVERY_ARCHITECTURES'),
  hostArch: z.string().describe('The arch the local fleet needs (arm64/amd64)'),
  lastSyncedMs: z.number().int().nonnegative().describe('Newest discovery-file mtime, epoch ms; 0 when nothing synced'),
});
export type DiscoveryProvenance = z.infer<typeof DiscoveryProvenanceSchema>;

export const StorageStateSchema = z.object({
  totalBytes: z.number().int().nonnegative().describe('Sum of all category sizes in bytes'),
  provenance: DiscoveryProvenanceSchema.describe('brokkr-live version/origin/arches + last-synced'),
  discoveryReachable: z
    .boolean()
    .describe('Whether the bridge discovery inventory responded this poll (false = spoke unreachable, state unknown)'),
  discoveryOk: z.boolean().describe('Host-arch required discovery set is present AND served'),
  categories: z.array(StorageCategorySchema).describe('All storage categories with present/size/mtime + items'),
});
export type StorageState = z.infer<typeof StorageStateSchema>;

export const StorageVerifyResultSchema = z.object({
  results: z
    .array(
      z.object({
        arch: z.string().describe('Architecture the file belongs to'),
        name: z.string().describe('Discovery file name'),
        status: z
          .enum(['match', 'stale', 'unverified'])
          .describe(
            'match = on-disk sha equals upstream manifest; stale = differs; unverified = sha/manifest unavailable',
          ),
      }),
    )
    .describe('Per-file sha comparison against the upstream manifest'),
});
export type StorageVerifyResult = z.infer<typeof StorageVerifyResultSchema>;
