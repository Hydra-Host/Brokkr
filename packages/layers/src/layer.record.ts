import { createActiveRecord } from '@repo/active-record';
import { type Layer, LayerKind } from '@repo/database';
import { z } from 'zod';

const LayerPersistenceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  family: z.string().nullable(),
  kind: z.nativeEnum(LayerKind),
  layerGroupId: z.string(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

export type LayerBaseOsSample = {
  osDistro: string;
  osCodename: string;
  osVersion: string;
};

export type LayerBaseWithOsSample = {
  slug: string;
  sample: LayerBaseOsSample | null;
};

export type BaseLayerSummary = Pick<Layer, 'id' | 'slug' | 'name' | 'family'>;

/** Deliberately read-only — writes live in the seed scripts / `LayerCatalogSeedService`; shared by admin and main so query shapes never drift. */
export class LayerRecord extends createActiveRecord(LayerPersistenceSchema, 'layer') {
  static async findAllKindsBySlug(): Promise<Map<string, LayerKind>> {
    const rows = await this._delegate().findMany({
      select: { slug: true, kind: true },
    });
    return new Map(rows.map((r) => [r.slug, r.kind]));
  }

  static async findBaseLayerSummaries(): Promise<BaseLayerSummary[]> {
    return this._delegate().findMany({
      where: { kind: LayerKind.BASE },
      select: { id: true, slug: true, name: true, family: true },
      orderBy: { slug: 'asc' },
    });
  }

  static async findBaseLayersWithOsSample(layerBuildId: string): Promise<LayerBaseWithOsSample[]> {
    const rows = await this._delegate().findMany({
      where: { kind: LayerKind.BASE },
      select: {
        slug: true,
        artifacts: {
          where: { layerBuildId },
          select: { osDistro: true, osCodename: true, osVersion: true },
          orderBy: [{ osDistro: 'asc' }, { osCodename: 'asc' }],
          take: 1,
        },
      },
      orderBy: { slug: 'asc' },
    });
    return rows.map((r) => ({
      slug: r.slug,
      sample: r.artifacts[0] ?? null,
    }));
  }

  static async findBaseOsSampleBySlug(slug: string, layerBuildId: string): Promise<LayerBaseOsSample | null> {
    const row = await this._delegate().findUnique({
      where: { slug },
      select: {
        artifacts: {
          where: { layerBuildId },
          select: { osDistro: true, osCodename: true, osVersion: true },
          orderBy: [{ osDistro: 'asc' }, { osCodename: 'asc' }],
          take: 1,
        },
      },
    });
    return row?.artifacts[0] ?? null;
  }

  static async findBySlug(slug: string): Promise<Layer | null> {
    return this._delegate().findUnique({ where: { slug } });
  }

  static async findBySlugIn(slugs: string[]): Promise<Layer[]> {
    if (slugs.length === 0) return [];
    return this._delegate().findMany({
      where: { slug: { in: slugs } },
    });
  }
}
