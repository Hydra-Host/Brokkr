import { useMemo, useState } from 'react';

import { ThanosChart } from '@/components/thanos-chart';
import type { ThanosQueryResult, ThanosRangeResult } from '@/contract';
import { ErrorBanner } from '@/features/datastore/shared';
import { tsr } from '@/lib/api';
import { bodyError, thrownBodyError } from '@/lib/errors';

import { type ThanosWindow, rangeLatestResult, rangeWindowQuery } from './range-window';
import { ThanosResultTable } from './thanos-result-table';

const PROMQL_MODES = ['instant', 'range'] as const;
type PromqlMode = (typeof PROMQL_MODES)[number];

export function PromqlRunner({ seed, win }: { seed: string; win: ThanosWindow }) {
  const [expr, setExpr] = useState(seed);
  const [mode, setMode] = useState<PromqlMode>('instant');
  const [instantResult, setInstantResult] = useState<ThanosQueryResult | null>(null);
  const [rangeResult, setRangeResult] = useState<ThanosRangeResult | null>(null);
  const [error, setError] = useState('');
  const [running, setRunning] = useState(false);

  const rangeTable = useMemo(() => (rangeResult ? rangeLatestResult(rangeResult) : null), [rangeResult]);

  const exec = () => {
    setError('');
    setRunning(true);
    const fail = (msg: string) => {
      setInstantResult(null);
      setRangeResult(null);
      setError(msg);
    };
    const request =
      mode === 'instant'
        ? tsr.queryThanos.query({ query: { query: expr } }).then((res) => {
            if (res.status === 200) {
              setInstantResult(res.body);
              setRangeResult(null);
            } else {
              fail(bodyError(res.body) ?? `query failed (${res.status})`);
            }
          })
        : tsr.queryThanosRange.query({ query: { query: expr, ...rangeWindowQuery(win, Date.now()) } }).then((res) => {
            if (res.status === 200) {
              setRangeResult(res.body);
              setInstantResult(null);
            } else {
              fail(bodyError(res.body) ?? `query failed (${res.status})`);
            }
          });
    void request.catch((err: unknown) => fail(thrownBodyError(err) ?? String(err))).finally(() => setRunning(false));
  };

  return (
    <div className="border-border-dim space-y-2 border-t px-3 pt-3 pb-3">
      <textarea
        value={expr}
        onChange={(e) => setExpr(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !running) exec();
        }}
        spellCheck={false}
        rows={2}
        placeholder="e.g. rate(cpu_usage_user[5m])"
        className="border-border-dim bg-bg-primary text-status-online/90 focus:border-accent/50 w-full resize-y rounded border px-3 py-2 font-mono text-xs outline-none"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={exec}
          disabled={running || !expr.trim()}
          className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {running ? 'running…' : 'Run'}
        </button>
        <div className="border-border-dim flex overflow-hidden rounded border font-mono text-[11px]">
          {PROMQL_MODES.map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={[
                'px-2 py-0.5 transition',
                mode === m ? 'bg-accent/15 text-accent' : 'text-text-dim hover:text-text-muted',
              ].join(' ')}
            >
              {m}
            </button>
          ))}
        </div>
        {mode === 'range' && <span className="text-text-dim font-mono text-[11px]">window {win}</span>}
        <span className="text-text-dim text-[11px]">⌘/Ctrl + Enter</span>
        {mode === 'instant' && instantResult && (
          <span className="text-text-dim font-mono text-[11px]">{instantResult.samples.length} series</span>
        )}
        {mode === 'range' && rangeResult && (
          <span className="text-text-dim font-mono text-[11px]">{rangeResult.series.length} series</span>
        )}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {mode === 'instant' && instantResult && <ThanosResultTable result={instantResult} />}
      {mode === 'range' && rangeResult && <ThanosChart series={rangeResult.series} />}
      {mode === 'range' && rangeTable && <ThanosResultTable result={rangeTable} />}
    </div>
  );
}
