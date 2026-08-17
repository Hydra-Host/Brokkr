import { createActiveRecord } from '@repo/active-record';
import { type PlatformSettings } from '@repo/database';
import { z } from 'zod';

const SINGLETON_ID = 'singleton';

const PlatformSettingsPersistenceSchema = z.object({
  id: z.string(),
  defaultLayerBuildId: z.string().nullable(),
  updatedById: z.string().nullable(),
  updatedAt: z.date(),
});

export class PlatformSettingsRecord extends createActiveRecord(PlatformSettingsPersistenceSchema, 'platformSettings') {
  static async get(): Promise<PlatformSettings> {
    const row = await this._delegate().findUnique({ where: { id: SINGLETON_ID } });
    if (!row) {
      throw new Error('PlatformSettings singleton row is missing — run migrations.');
    }
    return row;
  }
}
