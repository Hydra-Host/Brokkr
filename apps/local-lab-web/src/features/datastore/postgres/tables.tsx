import { useState } from 'react';

import type { PgTable } from '@/contract';

const ADMIN_TABLE_NAMES = new Set([
  'Account',
  'Session',
  'Verification',
  'VerificationToken',
  'Member',
  'Invitation',
  'Jwks',
  'ApiKey',
  'TwoFactor',
  'Passkey',
  'RateLimit',
]);

function isAdminTable(t: PgTable): boolean {
  return t.schema !== 'public' || t.name.startsWith('_') || t.name.startsWith('Admin') || ADMIN_TABLE_NAMES.has(t.name);
}

export function categorizeTables(tables: PgTable[]): { records: PgTable[]; admin: PgTable[]; empty: PgTable[] } {
  const records: PgTable[] = [];
  const admin: PgTable[] = [];
  const empty: PgTable[] = [];
  for (const t of tables) {
    if (isAdminTable(t)) admin.push(t);
    else if (t.estRows > 0) records.push(t);
    else empty.push(t);
  }
  return { records, admin, empty };
}

export function TableGroup({
  title,
  hint,
  tables,
  selected,
  onSelect,
  defaultOpen,
}: {
  title: string;
  hint: string;
  tables: PgTable[];
  selected: { schema: string; name: string } | null;
  onSelect: (t: PgTable) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const hasSelected = selected !== null && tables.some((t) => t.schema === selected.schema && t.name === selected.name);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-text-dim hover:text-text-muted flex w-full items-center gap-1.5 px-1 py-1 text-[11px] tracking-wide uppercase"
      >
        <span className="text-text-dim">{open || hasSelected ? '▾' : '▸'}</span>
        <span>{title}</span>
        <span className="text-text-dim">· {tables.length}</span>
        <span className="text-text-label ml-auto lowercase normal-case">{hint}</span>
      </button>
      {(open || hasSelected) && (
        <div className="mt-0.5 space-y-0.5">
          {tables.map((t) => (
            <TableButton
              key={`${t.schema}.${t.name}`}
              t={t}
              active={selected?.schema === t.schema && selected?.name === t.name}
              onSelect={onSelect}
            />
          ))}
          {tables.length === 0 && <div className="text-text-label px-2 py-1 text-xs">none</div>}
        </div>
      )}
    </div>
  );
}

function TableButton({ t, active, onSelect }: { t: PgTable; active: boolean; onSelect: (t: PgTable) => void }) {
  return (
    <button
      onClick={() => onSelect(t)}
      className={[
        'flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left font-mono text-xs',
        active ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-hover-bg',
      ].join(' ')}
    >
      <span className="truncate">
        {t.schema !== 'public' && <span className="text-text-dim">{t.schema}.</span>}
        {t.name}
      </span>
      <span className="text-text-dim shrink-0">{formatCount(t.estRows)}</span>
    </button>
  );
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
