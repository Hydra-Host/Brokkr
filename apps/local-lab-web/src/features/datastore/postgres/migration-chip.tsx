import { tsr } from '@/lib/api';
import { migrationChipState } from '@/lib/migration-chip';

const MIGRATION_CHIP_TONE = {
  red: 'border-status-offline/30 bg-status-offline/10 text-status-offline',
  amber: 'border-status-warning/30 bg-status-warning/10 text-status-warning',
  green: 'border-status-online/20 bg-status-online/[0.06] text-status-online/70',
} as const;

export function MigrationChip() {
  const q = tsr.getDbMigrations.useQuery({ queryKey: ['pg-migrations'] });
  const m = q.data?.status === 200 ? q.data.body : null;
  if (!m) return null;
  const { tone, text, title } = migrationChipState(m);
  return (
    <span className={`rounded-md border px-2 py-0.5 font-mono text-[11px] ${MIGRATION_CHIP_TONE[tone]}`} title={title}>
      {text}
    </span>
  );
}
