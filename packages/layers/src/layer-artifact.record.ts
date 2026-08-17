import { createActiveRecord } from '@repo/active-record';
import { type LayerArtifact, LayerKind, Prisma } from '@repo/database';
import { z } from 'zod';

const LayerArtifactPersistenceSchema = z.object({
  id: z.string(),
  layerId: z.string(),
  layerBuildId: z.string(),
  osDistro: z.string(),
  osCodename: z.string(),
  osVersion: z.string(),
  arch: z.string(),
  variant: z.string(),
  sha256: z.string(),
  url: z.string(),
  size: z.bigint(),
  compression: z.string(),
  kernel: z.string().nullable(),
  releaseVersion: z.string().nullable(),
  sourceVersion: z.string().nullable(),
  filename: z.string().nullable(),
  builtAt: z.date().nullable(),
  builtByPipelineId: z.bigint().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const componentArtifactSelect = {
  osDistro: true,
  osCodename: true,
  layer: {
    select: {
      id: true,
      slug: true,
      name: true,
      layerGroup: { select: { id: true, slug: true, name: true, selectionType: true } },
    },
  },
  relations: {
    select: {
      type: true,
      groupId: true,
      relatedLayer: { select: { slug: true } },
    },
  },
} satisfies Prisma.LayerArtifactSelect;

export type ComponentArtifactWithRelations = Prisma.LayerArtifactGetPayload<{
  select: typeof componentArtifactSelect;
}>;

export type RequiresRelatedSlugs = string[];

export class LayerArtifactRecord extends createActiveRecord(LayerArtifactPersistenceSchema, 'layerArtifact') {
  static async findActiveByLayerAndArch(
    layerBuildId: string,
    layerId: string,
    arch: string,
  ): Promise<LayerArtifact | null> {
    return this._delegate().findFirst({
      where: { layerBuildId, layerId, arch },
    });
  }

  static async findActiveByLayerArchAndOs(args: {
    layerBuildId: string;
    layerId: string;
    arch: string;
    osDistro: string;
    osCodename: string;
  }): Promise<LayerArtifact | null> {
    return this._delegate().findFirst({
      where: {
        layerBuildId: args.layerBuildId,
        layerId: args.layerId,
        arch: args.arch,
        osDistro: args.osDistro,
        osCodename: args.osCodename,
      },
    });
  }

  static async findActiveComponentsForOsPairs(args: {
    layerBuildId: string;
    slugs: string[];
    osPairs: { osDistro: string; osCodename: string }[];
    arch: string;
  }): Promise<ComponentArtifactWithRelations[]> {
    if (args.slugs.length === 0 || args.osPairs.length === 0) return [];
    return this._delegate().findMany({
      where: {
        layerBuildId: args.layerBuildId,
        arch: args.arch,
        layer: { kind: LayerKind.COMPONENT, slug: { in: args.slugs } },
        OR: args.osPairs.map((p) => ({ osDistro: p.osDistro, osCodename: p.osCodename })),
      },
      select: componentArtifactSelect,
    });
  }

  static async findRequiresRelatedSlugs(args: {
    layerBuildId: string;
    selectorSlug: string;
    osDistro: string;
    osCodename: string;
    arch?: string | null;
    relatedSlugPrefix: string;
  }): Promise<RequiresRelatedSlugs> {
    const artifacts = await this._delegate().findMany({
      where: {
        layerBuildId: args.layerBuildId,
        osDistro: args.osDistro,
        osCodename: args.osCodename,
        layer: { slug: args.selectorSlug },
        ...(args.arch ? { arch: args.arch } : {}),
      },
      select: {
        relations: {
          where: {
            type: 'REQUIRES',
            relatedLayer: { slug: { startsWith: args.relatedSlugPrefix } },
          },
          select: { relatedLayer: { select: { slug: true } } },
        },
      },
    });
    const compatible = new Set<string>();
    for (const a of artifacts) {
      for (const r of a.relations) {
        compatible.add(r.relatedLayer.slug);
      }
    }
    return [...compatible];
  }
}
