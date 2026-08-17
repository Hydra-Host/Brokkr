import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { LabContext } from '../client.js';
import labContractPkg from '../lab-contract.js';
import { runAndCollect, waitShape } from '../runs.js';
import { call, failOnError } from '../shared.js';
import type { ToolOptions } from './index.js';

const { WipeableCategoryIdSchema } = labContractPkg;

export function registerBuildTools(server: McpServer, ctx: LabContext, options: ToolOptions): void {
  server.tool(
    'lab_build_agent',
    'Repack brokkr-live + bridge-agent.img from the current agent sources; run after any live-agent edit so the next provision picks it up. Only consumed by the next provision — in-flight deployments are unaffected.',
    { ...waitShape },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            const res = await client.buildAgent({ body: {} });
            failOnError(res, 'buildAgent');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_build_ipxe',
    'Rebuild the iPXE EFI binaries + ISO the bridge serves via TFTP; run after edits to boot/ipxe overlays, config headers, or the autoexec script.',
    { ...waitShape },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            const res = await client.buildIpxe({ body: {} });
            failOnError(res, 'buildIpxe');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_build_netboot_grub',
    'Rebuild the GRUB EFI binaries the bridge serves at /api/grub; run after edits to boot/grub cfg files or GRUB module lists.',
    { ...waitShape },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            const res = await client.buildNetbootGrub({ body: {} });
            failOnError(res, 'buildNetbootGrub');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_seed_layers',
    'Seed the hub OS-layer catalog from a manifest URL (must be https on an allowlisted host — see lab_get_layers_default_url). Idempotent for an unchanged manifest.',
    {
      url: z.string().url().describe('Manifest or release-index URL'),
      ...waitShape,
    },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            const res = await client.seedManifest({ body: { url: args.url } });
            failOnError(res, 'seedManifest');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_get_layers_default_url',
    'The default OS-layers manifest/release-index URL derived from the configured asset origin (may be empty).',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getLayersDefaultUrl({});
        failOnError(res, 'getLayersDefaultUrl');
        return res.body;
      }),
  );

  server.tool(
    'lab_get_layers_manifest',
    'Fetch an OS-layers manifest server-side (follows one release-index indirection) and return the resolved URL + parsed document.',
    {
      url: z.string().optional().describe('Manifest or release-index URL; omit for the configured default'),
    },
    (args) =>
      call(ctx, async (client) => {
        const res = await client.getLayersManifest({ query: { url: args.url } });
        failOnError(res, 'getLayersManifest');
        return res.body;
      }),
  );

  server.tool('lab_list_layer_cache', 'Sha256 digests of OS-layer blobs already warm in the nginx cache.', {}, () =>
    call(ctx, async (client) => {
      const res = await client.getLayerCache({});
      failOnError(res, 'getLayerCache');
      return res.body;
    }),
  );

  server.tool(
    'lab_prime_layer_cache',
    'Pre-fetch one layer blob (by artifact sha256) into the nginx cache so a later provision serves it locally.',
    {
      sha: z.string().min(1).describe('Artifact sha256 to prime'),
      ...waitShape,
    },
    (args) =>
      call(ctx, (client) =>
        runAndCollect(
          ctx,
          async () => {
            const res = await client.primeBlob({ body: { sha: args.sha } });
            failOnError(res, 'primeBlob');
            return res.body.runId;
          },
          args,
        ),
      ),
  );

  server.tool(
    'lab_get_storage_state',
    'Per-category storage state: discovery images, built/boot artifacts, overlays, nginx cache.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.getStorageState({});
        failOnError(res, 'getStorageState');
        return res.body;
      }),
  );

  server.tool(
    'lab_verify_storage',
    'Compare upstream brokkr-live manifest sha256 values against the on-disk cache — match/stale/unverified per file. Read-only.',
    {},
    () =>
      call(ctx, async (client) => {
        const res = await client.verifyStorage({ body: {} });
        failOnError(res, 'verifyStorage');
        return res.body;
      }),
  );

  if (options.allowDestructive) {
    server.tool(
      'lab_wipe_storage',
      'DESTRUCTIVE-gated: delete the on-disk files for a wipeable storage category (discovery images, built artifacts, or boot artifacts).',
      {
        category: WipeableCategoryIdSchema.describe('Which wipeable category to delete'),
        ...waitShape,
      },
      (args) =>
        call(ctx, (client) =>
          runAndCollect(
            ctx,
            async () => {
              const res = await client.wipeStorage({ body: { category: args.category } });
              failOnError(res, 'wipeStorage');
              return res.body.runId;
            },
            args,
          ),
        ),
    );

    server.tool(
      'lab_nuke_layer_blob',
      'DESTRUCTIVE-gated: evict one blob from the nginx layer cache so the next request re-fetches it from origin (cold-provision testing).',
      {
        sha: z.string().min(1).describe('Artifact sha256 to evict'),
      },
      (args) =>
        call(ctx, async (client) => {
          const res = await client.nukeBlob({ body: { sha: args.sha } });
          failOnError(res, 'nukeBlob');
          return res.body;
        }),
    );
  }
}
