import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@repo/database';
import { Client } from 'pg';
import { z } from 'zod';
import { buildPrunableLayerFilter, buildReferencedLayerFilter } from './prune-filters';
import { resolveImportAction } from './resolve-import-action';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error(
    'DATABASE_URL environment variable is required. Set DATABASE_URL (e.g. in the devenv shell, or export it manually).',
  );
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const LAYER_GROUP_SLUGS = [
  'baseOS',
  'legacy',
  'gpuDriver',
  'gpuFramework',
  'mlFramework',
  'miscSoftware',
  'tee',
  'liveOS',
] as const;
const COMPONENT_GROUP_SLUGS = ['gpuDriver', 'gpuFramework', 'mlFramework', 'miscSoftware', 'tee'] as const;
const COMPONENT_CAPABLE_GROUPS: ReadonlySet<string> = new Set([...COMPONENT_GROUP_SLUGS, 'liveOS']);

const RequiresGroupSchema = z.object({
  group: z.enum(LAYER_GROUP_SLUGS),
  layers: z.array(z.string()).default([]),
});

const ManifestEntrySchema = z
  .object({
    kind: z.enum(['base', 'component', 'legacy']),
    name: z.string().min(1),
    version: z.string().nullable(),
    filename: z.string(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i),
    size: z.number().int().nonnegative(),
    os_distro: z.string(),
    os_version: z.string(),
    os_codename: z.string(),
    arch: z.enum(['amd64', 'arm64']),
    variant: z.string().nullable(),
    kernel: z.string().nullable(),
    release_version: z.string().nullable(),
    source_version: z.string().nullable(),
    built_at: z.string().datetime(),
    built_by_pipeline_id: z.number().int().positive(),
    url: z.string().url(),
    group: z.enum(LAYER_GROUP_SLUGS),
    family: z.string().optional(),
    display_name: z.string().min(1),
    requires: z.array(RequiresGroupSchema).default([]),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.kind === 'base' && entry.group !== 'baseOS') {
      ctx.addIssue({
        code: 'custom',
        path: ['group'],
        message: `base entries must have group='baseOS', got '${entry.group}'`,
      });
    }
    if (entry.kind === 'legacy' && entry.group !== 'legacy') {
      ctx.addIssue({
        code: 'custom',
        path: ['group'],
        message: `legacy entries must have group='legacy', got '${entry.group}'`,
      });
    }
    if (entry.kind === 'component' && !COMPONENT_CAPABLE_GROUPS.has(entry.group)) {
      ctx.addIssue({
        code: 'custom',
        path: ['group'],
        message: `component entries must use one of [${[...COMPONENT_CAPABLE_GROUPS].join(', ')}], got '${entry.group}'`,
      });
    }
  });

const ManifestGroupSchema = z
  .object({
    slug: z.string().min(1),
    name: z.string().min(1),
    selection_type: z.enum(['SINGLE_SELECT', 'MULTI_SELECT']),
  })
  .strict();

const MANIFEST_SCHEMA_VERSION = 7;

const ManifestSchema = z
  .object({
    schema_version: z.literal(MANIFEST_SCHEMA_VERSION),
    version: z.string().min(1),
    env: z.enum(['dev', 'stg', 'prod']),
    generated_at: z.string().datetime(),
    pipeline_id: z.number().int().positive(),
    promoted_from: z.string().optional(),
    promoted_at: z.string().datetime().optional(),
    promoted_by_pipeline_id: z.number().int().positive().optional(),
    groups: z.array(ManifestGroupSchema).default([]),
    layers: z.array(ManifestEntrySchema),
  })
  .strict();

type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

function familyForSlug(slug: string, kind: 'BASE' | 'LEGACY' | 'COMPONENT'): string {
  if (kind === 'BASE') return 'base';
  if (kind === 'LEGACY') return 'legacy';
  if (slug.startsWith('nvidia-driver-')) return 'driver';
  if (slug === 'mellanox-ofed') return 'driver';
  if (slug.startsWith('cuda-')) return 'runtime';
  if (slug.startsWith('pytorch-')) return 'framework';
  if (slug === 'docker' || slug === 'nvidia-container-toolkit') return 'platform';
  if (slug === 'tee-setup') return 'application';
  return 'application';
}

function manifestKindToDbKind(kind: 'base' | 'component' | 'legacy'): 'BASE' | 'COMPONENT' | 'LEGACY' {
  return kind === 'base' ? 'BASE' : kind === 'legacy' ? 'LEGACY' : 'COMPONENT';
}

const SYSTEM_LAYERS: ReadonlyArray<{
  slug: string;
  name: string;
  kind: 'LIVE' | 'BASE';
  group: 'liveOS' | 'baseOS';
  family: string;
}> = [
  { slug: 'ubuntu-rescue-os', name: 'Ubuntu Rescue OS', kind: 'LIVE', group: 'liveOS', family: 'live' },
  { slug: 'brokkr-discovery', name: 'Brokkr Live (discovery)', kind: 'LIVE', group: 'liveOS', family: 'live' },
  { slug: 'ipxe-custom', name: 'iPXE Custom', kind: 'BASE', group: 'baseOS', family: 'base' },
];

async function ensureLayerGroup(slug: string, name: string): Promise<string> {
  return (
    await prisma.layerGroup.upsert({
      where: { slug },
      update: { name },
      create: { slug, name, selectionType: 'SINGLE_SELECT' },
    })
  ).id;
}

function compressionForFilename(filename: string): 'zstd' | 'gzip' {
  if (filename.endsWith('.tar.zst') || filename.endsWith('.zst')) return 'zstd';
  if (filename.endsWith('.tar.gz') || filename.endsWith('.gz') || filename.endsWith('.tgz')) return 'gzip';
  throw new Error(`Cannot infer compression from filename ${filename}`);
}

function readFlag(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? '' : undefined;
}

let currentBuildId: string | null = null;
let buildMarkedReady = false;

async function main() {
  const startTime = Date.now();
  const url = readFlag('url');

  if (!url) {
    throw new Error('--url=<manifest-url> is required.');
  }

  if (readFlag('dry-run') !== undefined) {
    throw new Error(
      '--dry-run is no longer supported. Each manifest version now creates an immutable ' +
        'LayerBuild. Remove the flag and re-run to proceed.',
    );
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  Manifest Seed');
  console.log(`  URL:        ${url}`);
  console.log(`  Started at: ${new Date().toISOString()}`);
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('[Step 1/8] Fetching manifest...');
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch manifest: ${response.status} ${response.statusText}`);
  }
  const raw = await response.json();
  const manifest = ManifestSchema.parse(raw);
  console.log(`  Manifest version: ${manifest.version} (env=${manifest.env}, pipeline=${manifest.pipeline_id})`);
  console.log(`  Generated at:     ${manifest.generated_at}`);
  console.log(`  Schema version:   ${manifest.schema_version}`);
  console.log(`  Groups:           ${manifest.groups.length}`);
  console.log(`  Total entries:    ${manifest.layers.length}\n`);

  console.log('[Step 2/8] Creating LayerBuild...');
  const existingBuild = await prisma.layerBuild.findUnique({
    where: { version_env: { version: manifest.version, env: manifest.env } },
  });
  const action = resolveImportAction(existingBuild?.status ?? null);
  if (action === 'REIMPORT' && existingBuild) {
    console.log(`  Deleting stale build ${existingBuild.id} (status=${existingBuild.status}) for re-import`);
    // Relational filters inside one transaction — no TOCTOU gap from a pre-fetch.
    await prisma.$transaction(async (tx) => {
      await tx.deploymentLayer.deleteMany({
        where: { layerArtifact: { layerBuildId: existingBuild.id } },
      });
      await tx.layerArtifact.deleteMany({ where: { layerBuildId: existingBuild.id } });
      await tx.layerBuild.delete({ where: { id: existingBuild.id } });
    });
  }
  const layerBuild = await prisma.layerBuild.create({
    data: {
      version: manifest.version,
      env: manifest.env,
      schemaVersion: manifest.schema_version,
      manifestUrl: url,
      status: 'IMPORTING',
      pipelineId: BigInt(manifest.pipeline_id),
      generatedAt: new Date(manifest.generated_at),
      promotedFrom: manifest.promoted_from ?? null,
      promotedAt: manifest.promoted_at ? new Date(manifest.promoted_at) : null,
      promotedByPipelineId: manifest.promoted_by_pipeline_id ? BigInt(manifest.promoted_by_pipeline_id) : null,
    },
  });
  currentBuildId = layerBuild.id;
  console.log(`  Created LayerBuild ${layerBuild.id} (status=IMPORTING)\n`);

  console.log('[Step 3/8] Reconciling LayerGroup rows...');
  const groupIdBySlug = new Map<string, string>();
  let groupsCreated = 0;
  let groupsChanged = 0;

  const existingGroups = await prisma.layerGroup.findMany({
    where: { slug: { in: ['baseImages', ...manifest.groups.map((g) => g.slug)] } },
  });
  const existingGroupsBySlug = new Map(existingGroups.map((g) => [g.slug, g]));

  const baseImagesExisting = existingGroupsBySlug.get('baseImages');
  let baseGroup: { id: string };
  if (!baseImagesExisting) {
    baseGroup = await prisma.layerGroup.create({
      data: { slug: 'baseImages', name: 'Base Images', selectionType: 'SINGLE_SELECT' },
    });
    groupsCreated++;
  } else {
    baseGroup = baseImagesExisting;
  }
  groupIdBySlug.set('baseImages', baseGroup.id);

  for (const g of manifest.groups) {
    const existing = existingGroupsBySlug.get(g.slug);
    if (!existing) {
      const createdId = (
        await prisma.layerGroup.create({
          data: { slug: g.slug, name: g.name, selectionType: g.selection_type },
        })
      ).id;
      groupIdBySlug.set(g.slug, createdId);
      groupsCreated++;
    } else {
      if (existing.name !== g.name || existing.selectionType !== g.selection_type) {
        await prisma.layerGroup.update({
          where: { slug: g.slug },
          data: { name: g.name, selectionType: g.selection_type },
        });
        groupsChanged++;
      }
      groupIdBySlug.set(g.slug, existing.id);
    }
  }
  // System groups must resolve before layer reconciliation or entries referencing them fall through to baseImages.
  if (!groupIdBySlug.has('liveOS')) {
    groupIdBySlug.set('liveOS', await ensureLayerGroup('liveOS', 'Live & System Images'));
  }
  if (!groupIdBySlug.has('baseOS')) {
    groupIdBySlug.set('baseOS', await ensureLayerGroup('baseOS', 'Base OS Images'));
  }

  const totalGroups = manifest.groups.length + 1;
  const groupsUnchanged = totalGroups - groupsCreated - groupsChanged;
  console.log(`  Done — ${groupsCreated} created, ${groupsChanged} changed, ${groupsUnchanged} unchanged\n`);

  console.log('[Step 4/8] Reconciling Layer rows...');
  const layersByUid = new Map<string, ManifestEntry[]>();
  for (const entry of manifest.layers) {
    const key = entry.name;
    const list = layersByUid.get(key) ?? [];
    list.push(entry);
    layersByUid.set(key, list);
  }

  const layerIdsBySlug = new Map<string, string>();
  let layersCreated = 0;
  let layersChanged = 0;

  const existingLayers = await prisma.layer.findMany({
    where: { slug: { in: [...layersByUid.keys()] } },
  });
  const existingLayersBySlug = new Map(existingLayers.map((l) => [l.slug, l]));

  for (const [slug, entries] of layersByUid) {
    const sample = entries[0];
    const dbKind = manifestKindToDbKind(sample.kind);
    const family = sample.family ?? familyForSlug(slug, dbKind);
    const prettyName = sample.display_name;
    const layerGroupId = groupIdBySlug.get(sample.group) ?? baseGroup.id;

    const existing = existingLayersBySlug.get(slug);
    if (!existing) {
      const createdId = (
        await prisma.layer.create({
          data: { slug, name: prettyName, kind: dbKind, family, layerGroupId },
        })
      ).id;
      layerIdsBySlug.set(slug, createdId);
      layersCreated++;
    } else {
      if (
        existing.name !== prettyName ||
        existing.kind !== dbKind ||
        existing.family !== family ||
        existing.layerGroupId !== layerGroupId
      ) {
        await prisma.layer.update({
          where: { slug },
          data: { kind: dbKind, family, name: prettyName, layerGroupId },
        });
        layersChanged++;
      }
      layerIdsBySlug.set(slug, existing.id);
    }
  }
  const layersUnchanged = layersByUid.size - layersCreated - layersChanged;
  console.log(`  Done — ${layersCreated} created, ${layersChanged} changed, ${layersUnchanged} unchanged\n`);

  console.log('[Step 4b/8] Reconciling system (live + custom-iPXE) layers...');
  const liveGroupId = groupIdBySlug.get('liveOS')!;
  const systemBaseGroupId = groupIdBySlug.get('baseOS')!;
  let systemCreated = 0;
  let systemChanged = 0;
  for (const sys of SYSTEM_LAYERS) {
    const groupId = sys.group === 'liveOS' ? liveGroupId : systemBaseGroupId;
    const existing = await prisma.layer.findUnique({ where: { slug: sys.slug } });
    if (!existing) {
      const createdId = (
        await prisma.layer.create({
          data: { slug: sys.slug, name: sys.name, kind: sys.kind, family: sys.family, layerGroupId: groupId },
        })
      ).id;
      layerIdsBySlug.set(sys.slug, createdId);
      systemCreated++;
    } else {
      if (
        existing.name !== sys.name ||
        existing.kind !== sys.kind ||
        existing.family !== sys.family ||
        existing.layerGroupId !== groupId
      ) {
        await prisma.layer.update({
          where: { slug: sys.slug },
          data: { kind: sys.kind, name: sys.name, family: sys.family, layerGroupId: groupId },
        });
        systemChanged++;
      }
      layerIdsBySlug.set(sys.slug, existing.id);
    }
  }
  console.log(`  Done — ${systemCreated} created, ${systemChanged} changed\n`);

  let layersPruned = 0;
  let layersInUse = 0;
  console.log('[Step 5/8] Pruning Layer rows not in manifest...');
  const manifestSlugs = new Set(manifest.layers.map((e) => e.name));
  const keepSlugs = [...manifestSlugs, ...SYSTEM_LAYERS.map((l) => l.slug)];
  const staleLayers = await prisma.layer.findMany({
    where: buildPrunableLayerFilter(keepSlugs),
    select: { id: true, slug: true },
  });
  const referencedStaleLayers = await prisma.layer.count({
    where: buildReferencedLayerFilter(keepSlugs),
  });
  layersInUse = referencedStaleLayers;
  for (const layer of staleLayers) {
    await prisma.layerRelation.deleteMany({ where: { relatedLayerId: layer.id } });
    await prisma.layer.delete({ where: { id: layer.id } });
    console.log(`  Pruned: ${layer.slug}`);
    layersPruned++;
  }
  const inUseSuffix = layersInUse > 0 ? `, ${layersInUse} kept (in use)` : '';
  console.log(`  Done — ${layersPruned} pruned${inUseSuffix}\n`);

  console.log('[Step 6/8] Creating LayerArtifact + LayerRelation rows...');

  const baseSlugByDistroCodename = new Map<string, string>();
  for (const e of manifest.layers) {
    if (e.kind !== 'base') continue;
    const k = `${e.os_distro}/${e.os_codename}`;
    if (!baseSlugByDistroCodename.has(k)) baseSlugByDistroCodename.set(k, e.name);
  }
  const inferredBaseGroupName = manifest.layers.find((e) => e.kind === 'base')?.group ?? 'baseOS';

  let artifactsCreated = 0;
  let relationsCreated = 0;
  let relationsSkipped = 0;

  for (const entry of manifest.layers) {
    const layerId = layerIdsBySlug.get(entry.name);
    if (!layerId) continue;
    const variant = entry.variant ?? '';
    const compression = compressionForFilename(entry.filename);

    const manifestKey = `${entry.name}|${entry.os_distro}|${entry.os_codename}|${entry.arch}|${variant}`;

    const artifactData = {
      layerId,
      layerBuildId: layerBuild.id,
      osDistro: entry.os_distro,
      osCodename: entry.os_codename,
      osVersion: entry.os_version,
      arch: entry.arch,
      variant,
      sha256: entry.sha256,
      url: entry.url,
      size: BigInt(entry.size),
      compression,
      kernel: entry.kernel,
      releaseVersion: entry.release_version,
      sourceVersion: entry.source_version,
      filename: entry.filename,
      builtAt: new Date(entry.built_at),
      builtByPipelineId: BigInt(entry.built_by_pipeline_id),
    };

    const created = await prisma.layerArtifact.create({ data: artifactData, select: { id: true } });
    artifactsCreated++;

    if (entry.kind !== 'component') continue;

    const requires = [...entry.requires];
    const inferredBaseSlug = baseSlugByDistroCodename.get(`${entry.os_distro}/${entry.os_codename}`);
    if (inferredBaseSlug) {
      const alreadyHasBase = requires.some((r) => r.layers.includes(inferredBaseSlug));
      if (!alreadyHasBase) {
        requires.push({ group: inferredBaseGroupName, layers: [inferredBaseSlug] });
      }
    }

    const byRelatedLayerId = new Map<string, { relatedLayerId: string; type: 'REQUIRES'; groupId: string }>();
    for (const req of requires) {
      const groupId = `${manifestKey}-${req.group}`;
      for (const targetSlug of req.layers) {
        const relatedLayerId = layerIdsBySlug.get(targetSlug);
        if (!relatedLayerId) {
          relationsSkipped++;
          continue;
        }
        byRelatedLayerId.set(relatedLayerId, { relatedLayerId, type: 'REQUIRES', groupId });
      }
    }

    const desiredRelations = [...byRelatedLayerId.values()];
    if (desiredRelations.length > 0) {
      await prisma.layerRelation.createMany({
        data: desiredRelations.map((r) => ({ artifactId: created.id, ...r })),
      });
      relationsCreated += desiredRelations.length;
    }
  }

  console.log(`  Done — ${artifactsCreated} artifacts created`);
  console.log(
    `         relations: ${relationsCreated} created, ${relationsSkipped} skipped (target not in manifest)\n`,
  );

  console.log('[Step 7/8] Finalizing LayerBuild...');
  const { count: defaultSetCount } = await prisma.$transaction(async (tx) => {
    await tx.layerBuild.update({
      where: { id: layerBuild.id },
      data: { status: 'READY' },
    });
    return tx.platformSettings.updateMany({
      where: { id: 'singleton', defaultLayerBuildId: null },
      data: { defaultLayerBuildId: layerBuild.id },
    });
  });
  buildMarkedReady = true;
  console.log(`  Build ${layerBuild.id} status set to READY`);

  if (defaultSetCount > 0) {
    console.log(`  Set as global default build (no previous default)\n`);
  } else {
    console.log(`  Global default build already set, not overriding\n`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
  console.log('═══════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Build:      ${layerBuild.id} (version=${manifest.version}, env=${manifest.env})`);
  console.log(`  Groups:     ${groupsCreated} created, ${groupsChanged} changed, ${groupsUnchanged} unchanged`);
  console.log(`  Layers:     ${layersCreated} created, ${layersChanged} changed, ${layersUnchanged} unchanged`);
  console.log(`  Artifacts:  ${artifactsCreated} created`);
  console.log(`  Relations:  ${relationsCreated} created, ${relationsSkipped} skipped (target not in manifest)`);
  console.log(`  Layers:     ${layersPruned} pruned, ${layersInUse} kept (in use)`);
  console.log('───────────────────────────────────────────────────────');
  console.log(`  Duration:   ${elapsed}s`);
  console.log('═══════════════════════════════════════════════════════\n');
}

const SEED_LOCK_KEY = 'layer_catalog_seed';

async function withAdvisoryLock(fn: () => Promise<void>): Promise<void> {
  let lockClient: Client | null = new Client({ connectionString });
  try {
    await lockClient.connect();
    await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [SEED_LOCK_KEY]);
  } catch (error) {
    console.warn(
      `  Seed advisory lock unavailable (${error instanceof Error ? error.message : String(error)}); proceeding — ` +
        `schema constraints (Restrict FK + unique build) keep concurrent imports consistent`,
    );
    await lockClient.end().catch(() => {});
    lockClient = null;
  }
  try {
    await fn();
  } finally {
    if (lockClient) {
      await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [SEED_LOCK_KEY]).catch(() => {});
      await lockClient.end().catch(() => {});
    }
  }
}

const isSeedScript = process.argv.includes('--seed-script');
if (isSeedScript) {
  withAdvisoryLock(main)
    .then(async () => await prisma.$disconnect())
    .catch(async (e) => {
      console.error(e);
      try {
        if (currentBuildId && !buildMarkedReady) {
          await prisma.layerBuild.update({
            where: { id: currentBuildId },
            data: { status: 'FAILED', error: e instanceof Error ? e.message : String(e) },
          });
        }
      } catch (error) {
        console.error('Failed to mark layer build FAILED:', error);
      }
      await prisma.$disconnect();
      process.exit(1);
    });
}
