import type { DbMigrations } from '@/contract';

export type MigrationChipTone = 'red' | 'amber' | 'green';

export function migrationChipState(m: DbMigrations): { tone: MigrationChipTone; text: string; title?: string } {
  if (!m.tableExists) return { tone: 'amber', text: 'no schema — run migrate deploy or devenv up' };
  // failed is DB-determinable regardless of disk availability — it must win over the amber degradation note.
  if (m.failed.length) return { tone: 'red', text: `${m.failed.length} failed`, title: m.failed.join(', ') };
  if (m.note) return { tone: 'amber', text: 'migrations: on-disk unavailable', title: m.note };
  if (m.pending.length) return { tone: 'amber', text: `${m.pending.length} pending`, title: m.pending.join(', ') };
  if (m.missing.length) return { tone: 'amber', text: `${m.missing.length} missing`, title: m.missing.join(', ') };
  return { tone: 'green', text: `migrations up to date (${m.applied.length})` };
}
