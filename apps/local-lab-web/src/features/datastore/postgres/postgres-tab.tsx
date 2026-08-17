import { useMemo, useState } from 'react';

import { SectionHeading } from '@/components/console';
import type { PgTable } from '@/contract';
import {
  ErrorBanner,
  errText,
  useDatastoreSearch,
  useFilterParam,
  useSetDatastoreSearch,
} from '@/features/datastore/shared';
import { tsr } from '@/lib/api';

import { MigrationChip } from './migration-chip';
import { ResultTable } from './result-table';
import { rowRangeLabel } from './row-range';
import { SqlRunner } from './sql-runner';
import { TableGroup, categorizeTables } from './tables';

const PAGE = 100;

export function PostgresTab() {
  const tables = tsr.listPgTables.useQuery({ queryKey: ['pg-tables'] });
  const { schema, table, page: pageParam } = useDatastoreSearch();
  const setSearch = useSetDatastoreSearch();
  const { filter, setFilter } = useFilterParam('tableFilter');
  const [sqlOpen, setSqlOpen] = useState(false);

  const selected = schema !== undefined && table !== undefined ? { schema, name: table } : null;
  const page = pageParam ?? 0;

  const tableList: PgTable[] = tables.data?.status === 200 ? tables.data.body : [];
  const tablesErr = errText(tables.data, tables.error);
  const filtered = tableList.filter((t) => `${t.schema}.${t.name}`.toLowerCase().includes(filter.toLowerCase()));
  const grouped = useMemo(() => categorizeTables(filtered), [filtered]);

  const rows = tsr.getPgRows.useQuery({
    queryKey: ['pg-rows', selected?.schema, selected?.name, page],
    queryData: {
      params: { schema: selected?.schema ?? '', table: selected?.name ?? '' },
      query: { limit: PAGE, offset: page * PAGE, orderDir: 'asc' },
    },
    enabled: !!selected,
  });
  const rowsResult = rows.data?.status === 200 ? rows.data.body : null;
  const rowsErr = errText(rows.data, rows.error);

  const select = (t: PgTable) => setSearch({ schema: t.schema, table: t.name, page: undefined });
  const goPage = (next: number) => setSearch({ page: next > 0 ? next : undefined });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[18rem_1fr]">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <SectionHeading>Tables</SectionHeading>
          <MigrationChip />
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter tables…"
          className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-full rounded border px-2 py-1 text-xs outline-none"
        />
        {tablesErr && <ErrorBanner>{tablesErr}</ErrorBanner>}
        <div className="max-h-[70vh] space-y-2 overflow-auto pr-1">
          {!tablesErr && filtered.length === 0 ? (
            <div className="text-text-dim px-2 py-1 text-xs">no tables</div>
          ) : (
            !tablesErr && (
              <>
                <TableGroup
                  title="Records"
                  hint="rows > 0"
                  tables={grouped.records}
                  selected={selected}
                  onSelect={select}
                  defaultOpen
                />
                <TableGroup
                  title="Admin / Prisma"
                  hint="system · auth · migrations"
                  tables={grouped.admin}
                  selected={selected}
                  onSelect={select}
                />
                <TableGroup
                  title="No records"
                  hint="empty"
                  tables={grouped.empty}
                  selected={selected}
                  onSelect={select}
                />
              </>
            )
          )}
        </div>
      </div>

      <div className="min-w-0 space-y-4">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-text-primary font-mono text-sm">
                {selected.schema}.<span className="text-accent">{selected.name}</span>
              </h2>
              <div className="ml-auto flex items-center gap-2 text-xs">
                <button
                  onClick={() => goPage(Math.max(0, page - 1))}
                  disabled={page === 0}
                  className="border-border-dim text-text-muted hover:bg-hover-bg rounded border px-2 py-1 disabled:opacity-30"
                >
                  ← prev
                </button>
                <span className="text-text-dim font-mono">{rowRangeLabel(page, PAGE, rowsResult?.rowCount ?? 0)}</span>
                <button
                  onClick={() => goPage(page + 1)}
                  disabled={!rowsResult?.truncated}
                  className="border-border-dim text-text-muted hover:bg-hover-bg rounded border px-2 py-1 disabled:opacity-30"
                >
                  next →
                </button>
              </div>
            </div>
            {rowsErr && <ErrorBanner>{rowsErr}</ErrorBanner>}
            {rows.isLoading && <div className="text-text-dim text-sm">loading…</div>}
            {rowsResult && <ResultTable result={rowsResult} />}
          </>
        ) : (
          <div className="text-text-dim text-sm">select a table to browse its rows, or run a query below.</div>
        )}

        <div className="border-border-dim bg-text-dim/[0.02] rounded-lg border">
          <button
            onClick={() => setSqlOpen((o) => !o)}
            className="text-text-primary flex w-full items-center gap-2 px-3 py-2 text-sm"
          >
            <span className="text-accent/70">{sqlOpen ? '▾' : '▸'}</span>
            Read-only SQL
            <span className="text-text-dim font-mono text-[11px]">SELECT / WITH…SELECT / EXPLAIN / SHOW</span>
          </button>
          {sqlOpen && <SqlRunner />}
        </div>
      </div>
    </div>
  );
}
