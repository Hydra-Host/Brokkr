import { type CustomizationLayer } from '@repo/api-client';
import { TeeCapability } from '@repo/database';
import { compareCustomizationLayers, normalizeArchForArtifact, parseGpuFamily } from '@repo/utils';
import { hardwareEligibleLayerSlugs } from './device-layer-rules.utils';

import { LayerArtifactRecord } from './layer-artifact.record';
import { type BaseLayerSummary, LayerRecord } from './layer.record';
import { PlatformSettingsRecord } from './platform-settings.record';
import { resolveEffectiveBuild } from './resolve-effective-build';

export type CustomizationCatalog = {
  bases: BaseLayerSummary[];
  componentsByBase: Record<string, CustomizationLayer[]>;
};

export function emptyCustomizationCatalog(): CustomizationCatalog {
  return { bases: [], componentsByBase: {} };
}

type Hydratable = {
  gpus: Array<{ model: string; index: number }>;
  server: { teeCapable: TeeCapability } | null;
  architecture: string | null;
  zone: { id: string; layerBuildId: string | null } | null;
  customizationCatalog?: CustomizationCatalog;
};

function representativeGpuModel(gpus: Array<{ model: string; index: number }>): string | null {
  if (gpus.length === 0) return null;
  return [...gpus].sort((a, b) => a.index - b.index)[0].model;
}

export async function hydrateCustomizationCatalogs<T extends Hydratable>(
  devices: T[],
  opts?: {
    failSoftZoneResolution?: boolean;
    Exception?: new (message: string) => Error;
    onZoneResolutionError?: (zoneId: string, error: unknown) => void;
  },
): Promise<void> {
  if (devices.length === 0) return;

  const bases = await LayerRecord.findBaseLayerSummaries();

  const uniqueZones = new Map<string, { id: string; layerBuildId: string | null }>();
  for (const d of devices) {
    if (!d.zone || uniqueZones.has(d.zone.id)) continue;
    uniqueZones.set(d.zone.id, d.zone);
  }
  const anyNeedsDefault = [...uniqueZones.values()].some((z) => !z.layerBuildId);
  const defaultBuildId = anyNeedsDefault ? (await PlatformSettingsRecord.get()).defaultLayerBuildId : undefined;
  // null = zone resolution failed under fail-soft (devices get the empty catalog); undefined = zone never seen.
  const resolvedEntries = await Promise.all(
    [...uniqueZones].map(async ([id, zone]): Promise<readonly [string, string | null]> => {
      try {
        return [
          id,
          await resolveEffectiveBuild(zone, { Exception: opts?.Exception, prefetchedDefaultBuildId: defaultBuildId }),
        ];
      } catch (error) {
        if (!opts?.failSoftZoneResolution) throw error;
        opts.onZoneResolutionError?.(id, error);
        return [id, null];
      }
    }),
  );
  const buildByZoneId = new Map(resolvedEntries);

  const tupleKey = (gpuModel: string | null, teeCapable: boolean, arch: string, buildId: string) =>
    `${gpuModel ?? ''}|${teeCapable ? '1' : '0'}|${arch}|${buildId}`;

  const distinctTuples = new Map<
    string,
    { gpuModel: string | null; teeCapable: boolean; arch: string; buildId: string }
  >();
  for (const d of devices) {
    if (!d.zone) continue;
    const buildId = buildByZoneId.get(d.zone.id);
    if (buildId === undefined) {
      throw new Error(`invariant: buildByZoneId missing zone ${d.zone.id} after resolveEffectiveBuild`);
    }
    if (buildId === null) continue;
    const teeCapable = d.server?.teeCapable === TeeCapability.TRUE;
    const gpuModel = representativeGpuModel(d.gpus);
    const arch = normalizeArchForArtifact(d.architecture);
    distinctTuples.set(tupleKey(gpuModel, teeCapable, arch, buildId), { gpuModel, teeCapable, arch, buildId });
  }

  const componentsByTuple = new Map<string, Record<string, CustomizationLayer[]>>();
  await Promise.all(
    [...distinctTuples].map(async ([key, args]) => {
      componentsByTuple.set(key, await buildComponentsByBase(args));
    }),
  );

  for (const d of devices) {
    if (!d.zone) {
      d.customizationCatalog = { bases, componentsByBase: {} };
      continue;
    }
    const buildId = buildByZoneId.get(d.zone.id);
    if (buildId === undefined) {
      throw new Error(`invariant: buildByZoneId missing zone ${d.zone.id} after resolveEffectiveBuild`);
    }
    if (buildId === null) {
      d.customizationCatalog = emptyCustomizationCatalog();
      continue;
    }
    d.customizationCatalog = {
      bases,
      componentsByBase:
        componentsByTuple.get(
          tupleKey(
            representativeGpuModel(d.gpus),
            d.server?.teeCapable === TeeCapability.TRUE,
            normalizeArchForArtifact(d.architecture),
            buildId,
          ),
        ) ?? {},
    };
  }
}

export async function buildCustomizationCatalog(
  gpuModel: string | null,
  teeCapable: boolean,
  architecture: string | null,
  opts?: { onComponentError?: (error: unknown) => void; buildId?: string },
): Promise<CustomizationCatalog> {
  const { onComponentError, buildId } = opts ?? {};
  if (!buildId) {
    const bases = await LayerRecord.findBaseLayerSummaries();
    return { bases, componentsByBase: {} };
  }
  const [bases, componentsByBase] = await Promise.all([
    LayerRecord.findBaseLayerSummaries(),
    buildComponentsByBase({
      gpuModel,
      teeCapable,
      arch: normalizeArchForArtifact(architecture),
      buildId,
    }).catch((error): Record<string, CustomizationLayer[]> => {
      onComponentError?.(error);
      return {};
    }),
  ]);
  return { bases, componentsByBase };
}

async function buildComponentsByBase(args: {
  gpuModel: string | null;
  teeCapable: boolean;
  arch: string;
  buildId: string;
}): Promise<Record<string, CustomizationLayer[]>> {
  const hardwareEligible = hardwareEligibleLayerSlugs(args.gpuModel, args.teeCapable);
  if (hardwareEligible.length === 0) return {};

  const bases = await LayerRecord.findBaseLayersWithOsSample(args.buildId);

  const pairByBase = new Map<string, { osDistro: string; osCodename: string }>();
  const dedupedPairs = new Map<string, { osDistro: string; osCodename: string }>();
  for (const base of bases) {
    if (!base.sample) continue;
    const key = `${base.sample.osDistro}/${base.sample.osCodename}`;
    pairByBase.set(base.slug, base.sample);
    dedupedPairs.set(key, base.sample);
  }

  const family = parseGpuFamily(args.gpuModel);
  const result: Record<string, CustomizationLayer[]> = {};

  if (dedupedPairs.size === 0) {
    for (const base of bases) result[base.slug] = [];
    return result;
  }

  const allArtifacts = await LayerArtifactRecord.findActiveComponentsForOsPairs({
    layerBuildId: args.buildId,
    slugs: hardwareEligible,
    osPairs: [...dedupedPairs.values()],
    arch: args.arch,
  });

  type ArtifactRow = (typeof allArtifacts)[number];
  const artifactsByPair = new Map<string, ArtifactRow[]>();
  for (const a of allArtifacts) {
    const key = `${a.osDistro}/${a.osCodename}`;
    const arr = artifactsByPair.get(key);
    if (arr) arr.push(a);
    else artifactsByPair.set(key, [a]);
  }

  for (const base of bases) {
    const sample = pairByBase.get(base.slug);
    if (!sample) {
      result[base.slug] = [];
      continue;
    }
    const artifacts = artifactsByPair.get(`${sample.osDistro}/${sample.osCodename}`) ?? [];

    const groupMap = new Map<
      string,
      {
        group: { id: string; slug: string; name: string; selectionType: 'SINGLE_SELECT' | 'MULTI_SELECT' };
        options: Map<string, CustomizationLayer['options'][number]>;
      }
    >();

    const relationKey = (rel: CustomizationLayer['options'][number]['relations'][number]) =>
      `${rel.relatedOptionValue}|${rel.type}|${rel.groupId ?? ''}`;

    for (const a of artifacts) {
      const group = a.layer.layerGroup;
      let bucket = groupMap.get(group.id);
      if (!bucket) {
        bucket = { group, options: new Map() };
        groupMap.set(group.id, bucket);
      }
      const newRelations = a.relations.map((rel) => ({
        relatedOptionValue: rel.relatedLayer.slug,
        type: rel.type,
        groupId: rel.groupId ?? null,
      }));
      const existing = bucket.options.get(a.layer.slug);
      if (existing) {
        const seen = new Set(existing.relations.map(relationKey));
        for (const rel of newRelations) {
          if (seen.has(relationKey(rel))) continue;
          seen.add(relationKey(rel));
          existing.relations.push(rel);
        }
        continue;
      }
      const isDriverGroup = group.slug === 'gpuDriver';
      bucket.options.set(a.layer.slug, {
        value: a.layer.slug,
        label: a.layer.name,
        availability: null,
        relations: newRelations,
        hardwareCompatibility: isDriverGroup && family ? { gpuFamilies: [family] } : null,
      });
    }

    const layers = [...groupMap.values()].map(({ group, options }) => {
      const opts = [...options.values()];
      opts.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      return {
        slug: group.slug,
        name: group.name,
        selectionType: group.selectionType,
        options: opts,
      };
    });
    layers.sort(compareCustomizationLayers);

    result[base.slug] = layers;
  }

  return result;
}
