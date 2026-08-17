import { createActiveRecord } from '@repo/active-record';
import { type LayerBuild, LayerBuildStatus } from '@repo/database';
import { z } from 'zod';

const LayerBuildPersistenceSchema = z.object({
  id: z.string(),
  version: z.string(),
  env: z.string(),
  schemaVersion: z.number(),
  manifestUrl: z.string(),
  status: z.nativeEnum(LayerBuildStatus),
  error: z.string().nullable(),
  pipelineId: z.bigint().nullable(),
  generatedAt: z.date().nullable(),
  promotedFrom: z.string().nullable(),
  promotedAt: z.date().nullable(),
  promotedByPipelineId: z.bigint().nullable(),
  importedById: z.string().nullable(),
  importedAt: z.date(),
  updatedAt: z.date(),
});

export class LayerBuildRecord extends createActiveRecord(LayerBuildPersistenceSchema, 'layerBuild') {
  static async findById(id: string): Promise<LayerBuild | null> {
    return this._delegate().findUnique({ where: { id } });
  }
}
