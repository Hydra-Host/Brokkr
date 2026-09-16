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
  path: z.string().describe('Resolved local filesystem path (host-side dev tooling); empty when the root is unknown'),
  flavor: z
    .string()
    .optional()
    .describe('Discovery image flavor segment (light for the VM plane, full for real hardware); discovery items only'),
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

export const DiscoveryFlavorStateSchema = z.object({
  name: z.string().describe('Flavor segment the spoke syncs (light for the VM plane, full for real hardware)'),
  present: z.boolean().describe('Whether any file of this flavor is on disk'),
  fileCount: z.number().int().nonnegative().describe('Files of this flavor present on disk, across architectures'),
  sizeBytes: z.number().int().nonnegative().describe('Bytes those files occupy; 0 when none is present'),
});
export type DiscoveryFlavorState = z.infer<typeof DiscoveryFlavorStateSchema>;

export const DiscoveryProvenanceSchema = z.object({
  version: z.string().describe('brokkr-live version being synced (BROKKR_LIVE_VERSION)'),
  baseUrl: z
    .string()
    .describe('Flavor-less DISCOVERY_BASE_URL the spoke syncs from; the light tree hangs off <baseUrl>-light'),
  originHost: z.string().describe('Origin host parsed from DISCOVERY_BASE_URL'),
  architectures: z.array(z.string()).describe('Configured DISCOVERY_ARCHITECTURES'),
  flavors: z
    .array(DiscoveryFlavorStateSchema)
    .describe('One entry per configured DISCOVERY_FLAVORS value, in sync order, with what is on disk for it'),
  hostArch: z.string().describe('The arch the local fleet needs (arm64/amd64)'),
  lastSyncedMs: z.number().int().nonnegative().describe('Newest discovery-file mtime, epoch ms; 0 when nothing synced'),
});
export type DiscoveryProvenance = z.infer<typeof DiscoveryProvenanceSchema>;

export const DiscoverySyncSchema = z.object({
  at: z.number().int().describe('Epoch ms when the spoke finished its last discovery image sync pass'),
  outcome: z
    .enum(['ok', 'skipped', 'failed'])
    .describe('ok = a flavor synced files; skipped = every flavor was already current; failed = see error'),
  error: z
    .string()
    .nullable()
    .describe('Why the pass failed, as the spoke reported it; null when the pass was ok or skipped'),
  baseUrl: z.string().describe('Flavor-less discovery root the pass synced from (DISCOVERY_BASE_URL)'),
  version: z.string().describe('BROKKR_LIVE_VERSION the pass used; may be a latest-* alias'),
  flavors: z.array(z.string()).describe('Discovery flavors the pass covered, in sync order'),
});
export type DiscoverySync = z.infer<typeof DiscoverySyncSchema>;

export const StorageStateSchema = z.object({
  totalBytes: z.number().int().nonnegative().describe('Sum of all category sizes in bytes'),
  provenance: DiscoveryProvenanceSchema.describe('brokkr-live version/origin/arches + last-synced'),
  discoveryReachable: z
    .boolean()
    .describe('Whether the bridge discovery inventory responded this poll (false = spoke unreachable, state unknown)'),
  discoveryOk: z.boolean().describe('Host-arch required discovery set is present AND served'),
  lastSync: DiscoverySyncSchema.nullable().describe(
    "Outcome of the spoke's last discovery sync pass, read from its status route; null when the spoke is unreachable or no pass has finished since it started",
  ),
  categories: z.array(StorageCategorySchema).describe('All storage categories with present/size/mtime + items'),
});
export type StorageState = z.infer<typeof StorageStateSchema>;

export const StorageVerifyStatusSchema = z
  .enum(['match', 'stale', 'no-local-sha', 'manifest-unreachable', 'manifest-invalid'])
  .describe(
    'match = on-disk sha equals the upstream manifest; stale = differs; no-local-sha = the spoke cache metadata carries no sha for the file; manifest-unreachable = the manifest fetch failed, timed out or answered non-2xx; manifest-invalid = the manifest answered but is not a usable manifest or lists no sha for the file',
  );
export type StorageVerifyStatus = z.infer<typeof StorageVerifyStatusSchema>;

export const StorageVerifyResultSchema = z.object({
  results: z
    .array(
      z.object({
        flavor: z.string().describe('Discovery image flavor tree the file belongs to (light / full)'),
        arch: z.string().describe('Architecture the file belongs to'),
        name: z.string().describe('Discovery file name'),
        status: StorageVerifyStatusSchema,
        manifestError: z
          .string()
          .nullable()
          .describe(
            'Why the upstream manifest could not be used (timeout, HTTP status, parse error); null when it could',
          ),
      }),
    )
    .describe('Per-file sha comparison against the upstream manifest, one row per flavor, arch and file'),
});
export type StorageVerifyResult = z.infer<typeof StorageVerifyResultSchema>;
