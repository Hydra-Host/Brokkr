import { useMemo, useState } from 'react';

import { SectionHeading } from '@/components/console';
import { ThanosChart } from '@/components/thanos-chart';
import {
  CopyButton,
  ErrorBanner,
  errText,
  useDatastoreSearch,
  useFilterParam,
  useSetDatastoreSearch,
} from '@/features/datastore/shared';
import { tsr } from '@/lib/api';
import { thanosChartPending } from '@/lib/thanos-chart-state';
import { usePoll } from '@/lib/use-poll';
import { useRangeAnchor } from '@/lib/use-range-anchor';

import { PromqlRunner } from './promql-runner';
import { type ThanosWindow, rangeLatestResult, rangeWindowQuery } from './range-window';
import { ThanosMetadata } from './thanos-metadata';
import { ThanosResultTable } from './thanos-result-table';
import { WindowChips } from './window-chips';

const RANGE_ADVANCE_MS = 30_000;

export function ThanosTab() {
  const status = tsr.getThanosStatus.useQuery({ queryKey: ['thanos-status'], refetchInterval: usePoll(5000) });
  const metrics = tsr.listThanosMetrics.useQuery({ queryKey: ['thanos-metrics'], queryData: { query: {} } });
  const { metric: selected } = useDatastoreSearch();
  const setSearch = useSetDatastoreSearch();
  const { filter, setFilter } = useFilterParam('metricFilter');
  const [sqlOpen, setSqlOpen] = useState(false);
  const [win, setWin] = useState<ThanosWindow>('1h');
  const selectMetric = (m: string) => setSearch({ metric: m });

  const statusBody = status.data?.status === 200 ? status.data.body : null;
  const statusErr = errText(status.data, status.error);
  const metricsErr = errText(metrics.data, metrics.error);
  const metricList = !metricsErr && metrics.data?.status === 200 ? metrics.data.body : [];
  const metricCount = !metricsErr && metrics.data?.status === 200 ? metricList.length : null;
  const filtered = metricList.filter((m) => m.toLowerCase().includes(filter.toLowerCase()));
  const grouped = useMemo(() => groupMetrics(filtered), [filtered]);

  // the window must track wall-clock, or a focus refetch re-queries the window frozen at selection time
  const anchor = useRangeAnchor(selected ?? null, RANGE_ADVANCE_MS);
  const range = useMemo(() => (anchor ? rangeWindowQuery(win, anchor.nowMs) : null), [anchor, win]);
  const result = tsr.queryThanosRange.useQuery({
    queryKey: ['thanos-range', selected, win, range?.start, range?.end],
    queryData: {
      query: { query: selected ?? '', start: range?.start ?? '', end: range?.end ?? '', step: range?.step ?? '' },
    },
    enabled: !!selected && !!range,
    // each advance mints a new queryKey, so hold the previous series for the same metric+window —
    // without this the chart unmounts into a loading flash every RANGE_ADVANCE_MS
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[1] === selected && prevQuery?.queryKey[2] === win ? prev : undefined,
  });
  const resultErr = errText(result.data, result.error);
  const resultBody = !resultErr && result.data?.status === 200 ? result.data.body : null;
  const tableResult = useMemo(() => (resultBody ? rangeLatestResult(resultBody) : null), [resultBody]);
  const chartPending = thanosChartPending({ selected: !!selected, hasRange: !!range, isLoading: result.isLoading });

  return (
    <div className="space-y-4">
      {statusErr ? (
        <ErrorBanner>{statusErr}</ErrorBanner>
      ) : (
        <ThanosMetadata status={statusBody} metricCount={metricCount} />
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-2">
          <SectionHeading>Metrics</SectionHeading>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter metrics…"
            className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 w-full rounded border px-2 py-1 font-mono text-xs outline-none"
          />
          {metricsErr && <ErrorBanner>{metricsErr}</ErrorBanner>}
          <div className="max-h-[65vh] space-y-2 overflow-auto pr-1">
            {!metricsErr && filtered.length === 0 ? (
              <div className="text-text-dim px-1 py-1 text-xs">
                {metrics.isLoading ? 'loading…' : metricList.length > 0 ? `no metrics match “${filter}”` : 'no metrics'}
              </div>
            ) : (
              grouped.map((g) => <MetricGroup key={g.prefix} group={g} selected={selected} onSelect={selectMetric} />)
            )}
          </div>
        </div>

        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {selected ? (
              <>
                <h2 className="text-text-primary font-mono text-sm">
                  <span className="text-accent">{selected}</span>
                </h2>
                <CopyButton value={selected} title="copy metric name" />
              </>
            ) : (
              <span className="text-text-dim text-sm">select a metric to chart it, or run a query below.</span>
            )}
            <div className="ml-auto flex items-center gap-2">
              {resultBody && (
                <span className="text-text-dim font-mono text-[11px]">{resultBody.series.length} series</span>
              )}
              <WindowChips value={win} onChange={setWin} />
            </div>
          </div>

          {selected && (
            <>
              {resultErr && <ErrorBanner>{resultErr}</ErrorBanner>}
              {chartPending && <div className="text-text-dim text-sm">loading…</div>}
              {resultBody && <ThanosChart series={resultBody.series} />}
              {tableResult && <ThanosResultTable result={tableResult} />}
            </>
          )}

          <div className="border-border-dim bg-text-dim/[0.02] rounded-lg border">
            <button
              onClick={() => setSqlOpen((o) => !o)}
              className="text-text-primary flex w-full items-center gap-2 px-3 py-2 text-sm"
            >
              <span className="text-accent/70">{sqlOpen ? '▾' : '▸'}</span>
              PromQL
              <span className="text-text-dim font-mono text-[11px]">instant · range</span>
            </button>
            {sqlOpen && <PromqlRunner key={selected ?? 'up'} seed={selected ?? 'up'} win={win} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function groupMetrics(names: string[]): { prefix: string; names: string[] }[] {
  const map = new Map<string, string[]>();
  for (const n of names) {
    const prefix = n.includes('_') ? n.slice(0, n.indexOf('_')) : n;
    if (!map.has(prefix)) map.set(prefix, []);
    map.get(prefix)!.push(n);
  }
  return [...map.entries()]
    .map(([prefix, ns]) => ({ prefix, names: ns }))
    .sort((a, b) => a.prefix.localeCompare(b.prefix));
}

function MetricGroup({
  group,
  selected,
  onSelect,
}: {
  group: { prefix: string; names: string[] };
  selected: string | undefined;
  onSelect: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const hasSelected = selected !== undefined && group.names.includes(selected);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-text-dim hover:text-text-muted flex w-full items-center gap-1.5 px-1 py-1 text-[11px] tracking-wide uppercase"
      >
        <span className="text-text-dim">{open || hasSelected ? '▾' : '▸'}</span>
        <span>{group.prefix}</span>
        <span className="text-text-dim">· {group.names.length}</span>
      </button>
      {(open || hasSelected) && (
        <div className="mt-0.5 space-y-0.5">
          {group.names.map((m) => (
            <button
              key={m}
              onClick={() => onSelect(m)}
              className={[
                'flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11px]',
                selected === m ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-hover-bg',
              ].join(' ')}
            >
              <span className="truncate">{m}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
