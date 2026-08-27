import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useCallback, useState, type ReactNode } from 'react';

import { SectionHeading } from '@/components/console';
import type { AuditEvent, AuditOutcome, RequestOrigin } from '@/contract';
import { rowRangeLabel } from '@/features/datastore/postgres/row-range';
import { CopyButton, ErrorBanner, errText, isJsonLike, useDebouncedParam } from '@/features/datastore/shared';
import { tsr } from '@/lib/api';
import {
  AUDIT_METHODS,
  AUDIT_OUTCOMES,
  isAuditMethod,
  isAuditOutcome,
  matchesAuditQuery,
  validateAuditSearch,
  type AuditSearch,
} from '@/lib/audit-search';
import { usePoll } from '@/lib/use-poll';

const PAGE = 100;
const COLUMNS = ['when', 'method', 'path', 'handler', 'outcome', 'status', 'took', 'origin', 'run'];

const OUTCOME_COLOR: Record<AuditOutcome, string> = {
  ok: 'text-status-online',
  error: 'text-status-offline',
  denied: 'text-status-warning',
};

const CONTROL_CLASS =
  'border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 rounded border px-2 py-1 text-xs outline-none';
const PAGE_BTN_CLASS =
  'border-border-dim text-text-muted hover:bg-hover-bg rounded border px-2 py-1 disabled:opacity-30';

export function fmtDur(ms: number | null): string {
  if (ms === null) return '—';
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

export function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function originLabel(origin: RequestOrigin | null): string {
  if (origin === null) return 'system';
  const marks = [origin.loopback ? 'loopback' : 'remote', origin.tokenAuth ? 'token' : 'no token'];
  return [origin.ip ?? 'unknown ip', ...marks].join(' · ');
}

export function prettyParams(params: string): string {
  if (!isJsonLike(params)) return params;
  return JSON.stringify(JSON.parse(params), null, 2);
}

// an empty table must not claim the log is empty when a filter or a paged-back window is what emptied it
export function emptyLabel(filtered: boolean, page: number): string {
  if (filtered) return 'no audit events match these filters';
  if (page > 0) return 'no audit events on this page';
  return 'no audit events recorded yet';
}

function useSetAuditSearch() {
  const navigate = useNavigate({ from: '/audit' });
  return useCallback(
    (patch: Partial<AuditSearch>) => {
      void navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true });
    },
    [navigate],
  );
}

export function AuditView({
  search,
  setSearch,
}: {
  search: AuditSearch;
  setSearch: (patch: Partial<AuditSearch>) => void;
}) {
  const { outcome, method } = search;
  const page = search.page ?? 0;
  const commitFilter = useCallback((value: string | undefined) => setSearch({ q: value }), [setSearch]);
  const { filter, setFilter } = useDebouncedParam(search.q ?? '', commitFilter);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const events = tsr.listAuditEvents.useQuery({
    queryKey: ['audit', outcome, method, page],
    queryData: { query: { outcome, method, limit: PAGE, offset: page * PAGE } },
    // only the newest page grows; a paged-back window is fixed, so polling it would refetch settled history
    refetchInterval: usePoll(page === 0 ? 2000 : false),
  });
  const rows = events.data?.status === 200 ? events.data.body : [];
  const err = errText(events.data, events.error);
  const visible = rows.filter((event) => matchesAuditQuery(event, filter));
  const selected = visible.find((event) => event.id === selectedId) ?? null;

  const goPage = (next: number) => setSearch({ page: next > 0 ? next : undefined });

  return (
    <div data-tour="audit-log" className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SectionHeading>Audit log</SectionHeading>
        <span className="text-text-dim font-mono text-[11px]">every mutation and console attach · read-only</span>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <select
          value={outcome ?? ''}
          onChange={(e) =>
            setSearch({ outcome: isAuditOutcome(e.target.value) ? e.target.value : undefined, page: undefined })
          }
          title="Filter by outcome"
          className={CONTROL_CLASS}
        >
          <option value="">any outcome</option>
          {AUDIT_OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <select
          value={method ?? ''}
          onChange={(e) =>
            setSearch({ method: isAuditMethod(e.target.value) ? e.target.value : undefined, page: undefined })
          }
          title="Filter by recorded method — WS is a console attach, not an http verb"
          className={CONTROL_CLASS}
        >
          <option value="">any method</option>
          {AUDIT_METHODS.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <span className="text-text-dim font-mono text-[10px]">reads (GET) are not audited</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter this page by path or handler…"
          className={`${CONTROL_CLASS} w-64`}
        />
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => goPage(page - 1)} disabled={page === 0} className={PAGE_BTN_CLASS}>
            ← newer
          </button>
          <span className="text-text-dim font-mono">
            {rowRangeLabel(page, PAGE, rows.length)}
            {filter === '' ? '' : ` · ${visible.length} matching`}
          </span>
          <button onClick={() => goPage(page + 1)} disabled={rows.length < PAGE} className={PAGE_BTN_CLASS}>
            older →
          </button>
        </div>
      </div>

      {err && <ErrorBanner>{err}</ErrorBanner>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <AuditTable
          rows={visible}
          empty={emptyLabel(outcome !== undefined || method !== undefined || filter !== '', page)}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
        />
        <AuditDetail event={selected} />
      </div>
    </div>
  );
}

function AuditTable({
  rows,
  empty,
  selectedId,
  onSelect,
}: {
  rows: AuditEvent[];
  empty: string;
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  return (
    <div className="border-border-dim bg-bg-secondary max-h-[70vh] overflow-auto rounded-lg border">
      <table className="w-full border-collapse font-mono text-xs">
        <thead className="bg-bg-secondary sticky top-0">
          <tr>
            {COLUMNS.map((c) => (
              <th
                key={c}
                className="border-border-dim text-text-primary border-b px-3 py-2 text-left whitespace-nowrap"
              >
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((event) => (
            <tr
              key={event.id}
              onClick={() => onSelect(event.id)}
              className={`hover:bg-text-dim/[0.03] cursor-pointer align-top ${event.id === selectedId ? 'bg-accent/5' : ''}`}
            >
              <td className="border-border-dim text-text-muted border-b px-3 py-1.5 whitespace-nowrap">
                {fmtTs(event.ts)}
              </td>
              <td className="border-border-dim text-text-primary border-b px-3 py-1.5">{event.method}</td>
              <td className="border-border-dim text-text-primary border-b px-3 py-1.5">
                <span className="inline-block max-w-[36ch] truncate align-bottom" title={event.path}>
                  {event.path}
                </span>
              </td>
              <td className="border-border-dim text-accent/90 border-b px-3 py-1.5 whitespace-nowrap">
                {event.handler}
              </td>
              <td className={`border-border-dim border-b px-3 py-1.5 ${OUTCOME_COLOR[event.outcome]}`}>
                {event.outcome}
              </td>
              <td className="border-border-dim text-text-muted border-b px-3 py-1.5">{event.statusCode ?? '—'}</td>
              <td className="border-border-dim text-text-muted border-b px-3 py-1.5 whitespace-nowrap">
                {fmtDur(event.durationMs)}
              </td>
              <td className="border-border-dim text-text-muted border-b px-3 py-1.5 whitespace-nowrap">
                {originLabel(event.origin)}
              </td>
              <td className="border-border-dim text-text-dim border-b px-3 py-1.5">
                <span className="inline-block max-w-[14ch] truncate align-bottom" title={event.runId ?? ''}>
                  {event.runId ?? '—'}
                </span>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className="text-text-dim px-3 py-4 text-center">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <div className="text-text-dim text-[10px] tracking-wide uppercase">{label}</div>
      <div className="text-text-primary font-mono text-xs break-all">{children}</div>
    </div>
  );
}

function AuditDetail({ event }: { event: AuditEvent | null }) {
  if (event === null) {
    return (
      <div className="border-border-dim bg-bg-secondary text-text-dim rounded-lg border px-3 py-4 text-sm">
        select a row to see its origin, error, and full recorded params.
      </div>
    );
  }

  const params = event.params === null ? null : prettyParams(event.params);

  return (
    <div className="border-border-dim bg-bg-secondary space-y-3 rounded-lg border p-3">
      <Field label="handler">{event.handler}</Field>
      <Field label="request">{`${event.method} ${event.path}`}</Field>
      <Field label="outcome">
        <span className={OUTCOME_COLOR[event.outcome]}>{event.outcome}</span>
        {` · ${event.statusCode ?? 'no status'} · ${fmtDur(event.durationMs)}`}
      </Field>
      <Field label="when">{fmtTs(event.ts)}</Field>
      <Field label="origin">{originLabel(event.origin)}</Field>
      <Field label="run">{event.runId ?? 'none'}</Field>
      {event.error !== null && (
        <Field label="error">
          <span className="text-status-offline">{event.error}</span>
        </Field>
      )}
      <div className="space-y-1">
        <div className="flex items-center gap-1">
          <span className="text-text-dim text-[10px] tracking-wide uppercase">params</span>
          {params !== null && <CopyButton value={params} />}
        </div>
        {params === null ? (
          <div className="text-text-label text-xs italic">none recorded</div>
        ) : (
          <pre className="border-border-dim bg-bg-primary text-status-online/90 max-h-80 overflow-auto rounded border p-2 font-mono text-[11px] whitespace-pre-wrap">
            {params}
          </pre>
        )}
      </div>
    </div>
  );
}

function AuditPage() {
  const search = Route.useSearch();
  const setSearch = useSetAuditSearch();
  return <AuditView search={search} setSearch={setSearch} />;
}

export const Route = createFileRoute('/audit')({
  component: AuditPage,
  validateSearch: validateAuditSearch,
});
