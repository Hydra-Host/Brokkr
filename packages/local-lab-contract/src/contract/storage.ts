import { z } from 'zod';
import { ErrorBodySchema } from '../schemas/common';
import { StorageStateSchema, StorageVerifyResultSchema, WipeableCategoryIdSchema } from '../schemas/storage';

export const storageRoutes = {
  getStorageState: {
    method: 'GET',
    path: '/api/storage/state',
    responses: { 200: StorageStateSchema },
    summary: 'Get image/storage state',
    description:
      'Per-category storage state (discovery images via the bridge inventory endpoint; built/boot artifacts, overlays, nginx cache via host stat) for the control-center Storage view.',
  },
  wipeStorage: {
    method: 'POST',
    path: '/api/storage/wipe',
    body: z.object({
      category: WipeableCategoryIdSchema.describe('Which wipeable category to delete'),
    }),
    responses: {
      200: z.object({ runId: z.string() }).describe('Streamed wipe run id (SSE at /api/runs/:runId/stream)'),
      400: ErrorBodySchema,
    },
    summary: 'Wipe a storage category',
    description:
      'Deletes the on-disk files for a wipeable category (discovery images, built artifacts, or boot artifacts) as a streamed background run. Destructive — the UI confirms first. Loopback-only: a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  resyncStorage: {
    method: 'POST',
    path: '/api/storage/resync',
    body: z.object({}),
    responses: { 200: z.object({ runId: z.string() }) },
    summary: 'Re-sync discovery images',
    description:
      'Restarts the spoke so its startup bridge_sync re-downloads the discovery images; progress streams over SSE. Non-destructive. Loopback-only (it restarts a host process and rewrites the image cache): a valid LAB_API_TOKEN is not sufficient and a remote caller gets 403.',
  },
  verifyStorage: {
    method: 'POST',
    path: '/api/storage/verify',
    body: z.object({}),
    responses: { 200: StorageVerifyResultSchema },
    summary: 'Verify discovery-image shas',
    description:
      'Fetches the upstream brokkr-live manifest per served flavor and arch (20 s budget each) and compares its sha256 values against the on-disk cache metadata, reporting match/stale per file or the named reason it could not be compared. Read-only, on-demand.',
  },
} as const;
