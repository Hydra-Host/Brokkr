import { useMemo, useState } from 'react';

import type { ProcessEnvVar } from '@/contract';
import { tsr } from '@/lib/api';
import { errorMessage } from '@/lib/errors';

export function ProcessEnvPane({ name }: { name: string }) {
  const [reveal, setReveal] = useState(false);
  const [filter, setFilter] = useState('');
  const q = tsr.getProcessEnv.useQuery({
    queryKey: ['process-env', name, reveal],
    queryData: { params: { name }, query: reveal ? { reveal: 'true' } : {} },
  });

  const body = q.data?.status === 200 ? q.data.body : null;
  const err = errorMessage(q.error);
  const drift = useMemo(() => new Set(body?.driftKeys ?? []), [body]);
  const vars = (body?.vars ?? []).filter((v) => `${v.key}=${v.value}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="border-border-dim bg-bg-secondary flex min-h-0 flex-1 flex-col rounded-md border">
      <div className="border-border-dim flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs">
        <span className="text-text-primary font-mono">{name}</span>
        {body && (
          <span
            className={[
              'rounded px-1.5 py-0.5 text-[10px] tracking-wide uppercase',
              body.source === 'live' ? 'bg-status-online/15 text-status-online' : 'bg-hover-bg text-text-muted',
            ].join(' ')}
            title={body.note ?? (body.source === 'live' ? 'read from /proc/<pid>/environ' : '')}
          >
            {body.source}
          </span>
        )}
        {body && <span className="text-text-dim">{body.vars.length} vars</span>}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter…"
          className="border-border-dim text-text-primary placeholder:text-text-label focus:border-accent/50 ml-auto w-40 rounded border bg-transparent px-2 py-0.5 font-mono focus:outline-none"
        />
        <button
          onClick={() => setReveal((r) => !r)}
          className={[
            'rounded border px-2 py-0.5 transition',
            reveal
              ? 'border-status-warning/40 bg-status-warning/10 text-status-warning'
              : 'border-border-dim text-text-muted hover:bg-hover-bg',
          ].join(' ')}
          title="Unmask secret values (password/token/DSN)"
        >
          {reveal ? 'hide secrets' : 'reveal secrets'}
        </button>
      </div>

      {body?.note && <div className="text-text-dim px-3 py-1.5 text-[11px]">{body.note}</div>}
      {err && <div className="text-status-offline px-3 py-2 text-xs">{err}</div>}
      {q.isPending && !body && <div className="text-text-dim px-3 py-2 text-xs">loading…</div>}

      <div className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-xs">
        {vars.map((v) => (
          <EnvRow key={v.key} v={v} revealed={reveal} drifted={drift.has(v.key)} />
        ))}
        {body && vars.length === 0 && <div className="text-text-dim">no matching vars</div>}
      </div>
    </div>
  );
}

function EnvRow({ v, revealed, drifted }: { v: ProcessEnvVar; revealed: boolean; drifted: boolean }) {
  return (
    <div className="border-border-dim flex gap-2 border-b py-0.5 last:border-0">
      <span className="text-accent/80 shrink-0">{v.key}</span>
      <span className="text-text-dim">=</span>
      <span className={['min-w-0 break-all', v.secret && !revealed ? 'text-text-dim' : 'text-text-primary'].join(' ')}>
        {v.value}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1 text-[10px]">
        {drifted && (
          <Badge
            label="drift"
            cls="bg-status-warning/15 text-status-warning"
            title="live value differs from the configured env"
          />
        )}
        {v.origin === 'live-only' && (
          <Badge
            label="live-only"
            cls="bg-hover-bg text-text-dim"
            title="present in /proc but not in the configured process env (shell-inherited or a sidecar)"
          />
        )}
        {v.secret && (
          <Badge label="secret" cls="bg-status-offline/15 text-status-offline" title="masked unless revealed" />
        )}
      </span>
    </div>
  );
}

function Badge({ label, cls, title }: { label: string; cls: string; title: string }) {
  return (
    <span title={title} className={`rounded px-1 py-0.5 tracking-wide uppercase ${cls}`}>
      {label}
    </span>
  );
}
