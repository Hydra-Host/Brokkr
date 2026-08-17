import { BadRequestException, Injectable } from '@nestjs/common';
import { LayerKind } from '@repo/database';
import { LayerArtifactRecord, LayerRecord } from '@repo/layers';
import { Logger } from 'src/common/decorators/logger.decorator';
import { LoggerService } from 'src/logger/logger.service';
import { OsLayerEntry } from '../types/lifecycle.types';

const FAMILY_STACK_ORDER: readonly string[] = [
  'base',
  'legacy',
  'driver',
  'runtime',
  'platform',
  'toolkit',
  'framework',
  'application',
  'diagnostic',
];

const FALLBACK_FAMILY_INDEX = FAMILY_STACK_ORDER.length;

interface ResolveArgs {
  layerBuildId: string;
  operatingSystemSlug: string;
  customizationSlugs: string[];
  arch: 'amd64' | 'arm64';
}

export interface ResolvedLayerRef {
  layerId: string;
  layerArtifactId: string;
}

export interface ResolveResult {
  entries: OsLayerEntry[];
  resolved: ResolvedLayerRef[];
}

@Injectable()
export class OsLayersResolverService {
  constructor(
    @Logger(OsLayersResolverService.name)
    private readonly logger: LoggerService,
  ) {}

  async resolve(args: ResolveArgs, jobId?: string): Promise<ResolveResult> {
    const { layerBuildId } = args;

    const baseLayer = await LayerRecord.findBySlug(args.operatingSystemSlug);
    if (!baseLayer) {
      throw new BadRequestException(
        `No Layer for OS slug ${args.operatingSystemSlug}. Seed catalog before provisioning.`,
      );
    }
    if (baseLayer.kind !== LayerKind.BASE) {
      throw new BadRequestException(
        `Layer ${args.operatingSystemSlug} is not a base layer (expected kind=BASE, got ${baseLayer.kind}).`,
      );
    }

    const baseArtifact = await LayerArtifactRecord.findActiveByLayerAndArch(layerBuildId, baseLayer.id, args.arch);
    if (!baseArtifact) {
      throw new BadRequestException(
        `No LayerArtifact for base layer=${baseLayer.slug} on arch=${args.arch} in build ${layerBuildId}.`,
      );
    }

    const componentLayers = await LayerRecord.findBySlugIn(args.customizationSlugs);
    const foundSlugs = new Set(componentLayers.map((l) => l.slug));
    const missing = args.customizationSlugs.filter((s) => !foundSlugs.has(s));
    if (missing.length > 0) {
      throw new BadRequestException(
        `Missing Layer rows for customization slugs: ${missing.join(', ')}. Seed catalog before provisioning.`,
      );
    }
    const wrongKind = componentLayers.find((l) => l.kind !== LayerKind.COMPONENT);
    if (wrongKind) {
      throw new BadRequestException(
        `Layer ${wrongKind.slug} is not a customization layer (expected kind=COMPONENT, got ${wrongKind.kind}).`,
      );
    }

    const componentEntries = await Promise.all(
      componentLayers.map(async (layer) => {
        const artifact = await LayerArtifactRecord.findActiveByLayerArchAndOs({
          layerBuildId,
          layerId: layer.id,
          arch: args.arch,
          osDistro: baseArtifact.osDistro,
          osCodename: baseArtifact.osCodename,
        });
        if (!artifact) {
          throw new BadRequestException(
            `No LayerArtifact for layer=${layer.slug} on ${baseArtifact.osDistro}/${baseArtifact.osCodename}/${args.arch} in build ${layerBuildId}.`,
          );
        }
        return { layer, artifact };
      }),
    );

    const sortedComponents = componentEntries
      .map((e) => ({ ...e, compression: ensureSupportedCompression(e.artifact.compression, e.layer, args.arch) }))
      .sort((a, b) => {
        const aIdx = familyIndex(a.layer.family);
        const bIdx = familyIndex(b.layer.family);
        if (aIdx !== bIdx) return aIdx - bIdx;
        return a.layer.slug.localeCompare(b.layer.slug);
      });

    const entries = [
      {
        layer: baseLayer,
        artifact: baseArtifact,
        compression: ensureSupportedCompression(baseArtifact.compression, baseLayer, args.arch),
      },
      ...sortedComponents,
    ];

    const wireEntries: OsLayerEntry[] = entries.map((entry, index) => ({
      layer: entry.layer.slug,
      sha256: entry.artifact.sha256,
      compression: entry.compression,
      stack_position: index,
    }));

    const resolved: ResolvedLayerRef[] = entries.map((entry) => ({
      layerId: entry.layer.id,
      layerArtifactId: entry.artifact.id,
    }));

    this.logger.log(
      `Resolved ${wireEntries.length} os_layers for ${args.operatingSystemSlug} (${baseLayer.kind}) on ${baseArtifact.osDistro}/${baseArtifact.osCodename}/${args.arch} [build=${layerBuildId}]: ${wireEntries.map((r) => r.layer).join(', ')}`,
      jobId,
    );

    return { entries: wireEntries, resolved };
  }
}

function familyIndex(family: string | null): number {
  if (!family) return FALLBACK_FAMILY_INDEX;
  const idx = FAMILY_STACK_ORDER.indexOf(family);
  return idx === -1 ? FALLBACK_FAMILY_INDEX : idx;
}

function ensureSupportedCompression(value: string, layer: { slug: string }, arch: 'amd64' | 'arm64'): 'zstd' | 'gzip' {
  if (value === 'zstd' || value === 'gzip') return value;
  throw new BadRequestException(
    `Layer "${layer.slug}" (arch=${arch}) has unsupported compression "${value}"; bridge accepts only zstd, gzip.`,
  );
}
