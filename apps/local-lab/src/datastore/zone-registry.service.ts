import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';

import { readRows } from '../common/lenient-rows';
import { PgService } from './pg.service';

// a zone with an unusable name is still a zone, so the name normalizes to null rather than
// costing the row — only a missing id makes a row unusable, and parseRows counts those.
const ZoneRowSchema = z.object({
  id: z.string().min(1),
  deletedAt: z.unknown().transform((value) => value !== null && value !== undefined),
  name: z.unknown().transform((value) => (typeof value === 'string' && value.length > 0 ? value : null)),
});

export type ZoneRow = z.infer<typeof ZoneRowSchema>;

@Injectable()
export class ZoneRegistryService {
  private readonly log = new Logger(ZoneRegistryService.name);

  constructor(private readonly pgService: PgService) {}

  /** Reports the failure rather than folding it into an empty list: a caller reconciling the hub
   *  against the fleet must tell "the hub has no zones" from "the hub could not be read". */
  async readZones(): Promise<{ zones: ZoneRow[]; readError: string | null }> {
    try {
      const res = await this.pgService.runQuery('SELECT id, name, "deletedAt" FROM "Zone"');
      const { rows, skipped } = readRows(ZoneRowSchema, res.rows);
      if (skipped > 0) this.log.warn(`zone registry: skipped ${skipped} unusable zone row(s)`);
      return { zones: rows, readError: null };
    } catch (e) {
      const readError = e instanceof Error ? e.message : String(e);
      this.log.warn(`zone registry: could not read zones — ${readError}`);
      return { zones: [], readError };
    }
  }

  async listZones(): Promise<ZoneRow[]> {
    return (await this.readZones()).zones;
  }

  /** Unfiltered on purpose: the saga in-flight guard counts these, and an under-count strands
   *  in-flight sagas, so a deprovisioned zone's queues must stay countable. */
  async listZoneIds(): Promise<string[]> {
    return (await this.listZones()).map((zone) => zone.id);
  }

  /** A deprovisioned zone has no bridges to observe, so reporting it would show a permanent
   *  unheld lease and an unenrolled zone for something that no longer exists. */
  async listLiveZones(): Promise<ZoneRow[]> {
    return (await this.listZones()).filter((zone) => !zone.deletedAt);
  }
}
