import { useState } from 'react';

import type { PgResult } from '@/contract';
import { ErrorBanner } from '@/features/datastore/shared';
import { tsr } from '@/lib/api';
import { bodyError, thrownBodyError } from '@/lib/errors';
import { useHostToken } from '@/lib/use-host-token';

import { ResultTable } from './result-table';

export function SqlRunner() {
  const [sql, setSql] = useState('SELECT * FROM "Device" LIMIT 50;');
  const run = tsr.runPgQuery.useMutation();
  const gate = useHostToken('The SQL console');
  const [result, setResult] = useState<PgResult | null>(null);
  const [error, setError] = useState('');

  const exec = () => {
    setError('');
    if (gate.blocked) {
      gate.ask();
      return;
    }
    run.mutate(
      // overrides the injected token for this call only: the query runs as the stack owner, and
      // `extraHeaders` is what outranks the client's baseHeaders.
      { body: { sql }, extraHeaders: { 'x-lab-token': gate.token } },
      {
        onSuccess: (res) => {
          if (res.status === 200) {
            setResult(res.body);
          } else {
            setResult(null);
            gate.noteRefusal(res.status, res.body);
            setError(bodyError(res.body) ?? `query failed (${res.status})`);
          }
        },
        onError: (err: unknown) => {
          gate.noteThrownRefusal(err);
          setError(thrownBodyError(err) ?? 'query failed');
          setResult(null);
        },
      },
    );
  };

  return (
    <div className="border-border-dim space-y-2 border-t px-3 pt-3 pb-3">
      {gate.dialog}
      <textarea
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') exec();
        }}
        spellCheck={false}
        rows={4}
        className="border-border-dim bg-bg-primary text-status-online/90 focus:border-accent/50 w-full resize-y rounded border px-3 py-2 font-mono text-xs outline-none"
      />
      <div className="flex items-center gap-3">
        <button
          onClick={exec}
          disabled={run.isPending}
          className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {run.isPending ? 'running…' : 'Run'}
        </button>
        <span className="text-text-dim text-[11px]">⌘/Ctrl + Enter</span>
        {result && <span className="text-text-dim font-mono text-[11px]">{result.rowCount} rows</span>}
      </div>
      {error && <ErrorBanner>{error}</ErrorBanner>}
      {result && <ResultTable result={result} />}
    </div>
  );
}
