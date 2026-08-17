import type { RedisValue } from '@/contract';
import { Cell, CopyButton, ErrorBanner, errText, isJsonLike } from '@/features/datastore/shared';
import { tsr } from '@/lib/api';

import { TYPE_COLOR } from './type-color';

export function RedisValuePanel({ keyName }: { keyName: string }) {
  const q = tsr.getRedisValue.useQuery({
    queryKey: ['redis-value', keyName],
    queryData: { query: { key: keyName } },
  });
  const body = q.data?.status === 200 ? q.data.body : null;
  const err = errText(q.data, q.error);

  if (err) return <ErrorBanner>{err}</ErrorBanner>;
  if (!body) return <div className="text-text-dim text-sm">loading…</div>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-text-primary font-mono text-sm break-all">{body.key}</span>
        <CopyButton value={body.key} title="copy key" />
        <span className={`font-mono text-xs ${TYPE_COLOR[body.type] ?? 'text-text-dim'}`}>{body.type}</span>
        <span className="text-text-dim font-mono text-xs">
          ttl {body.ttl === -1 ? 'none' : body.ttl === -2 ? 'gone' : `${body.ttl}s`}
        </span>
        <span className="text-text-dim font-mono text-xs">{body.length} elem</span>
        {body.truncated && (
          <span className="text-status-warning/70 text-[11px]">truncated — showing first {capLabel(body)}</span>
        )}
      </div>
      <RedisValueBody value={body} />
    </div>
  );
}

function capLabel(v: RedisValue): number {
  if (v.kind === 'hash') return Object.keys(v.value).length;
  if (v.kind === 'list' || v.kind === 'set' || v.kind === 'zset' || v.kind === 'stream') return v.value.length;
  return 0;
}

function RedisValueBody({ value }: { value: RedisValue }) {
  if (value.kind === 'none') return <div className="text-text-dim text-sm">key not found.</div>;

  if (value.kind === 'string') {
    const raw = value.value ?? '';
    const json = isJsonLike(raw) ? JSON.stringify(JSON.parse(raw), null, 2) : null;
    return (
      <div className="border-border-dim bg-bg-secondary relative rounded-lg border p-3">
        <div className="absolute top-2 right-2">
          <CopyButton value={raw} title="copy value" />
        </div>
        <pre className="text-status-online/90 max-h-[60vh] overflow-auto font-mono text-xs whitespace-pre-wrap">
          {json ?? raw}
        </pre>
      </div>
    );
  }

  if (value.kind === 'list' || value.kind === 'set') {
    const items = value.value;
    return (
      <div className="border-border-dim bg-bg-secondary max-h-[60vh] overflow-auto rounded-lg border">
        <table className="w-full font-mono text-xs">
          <tbody>
            {items.map((it, i) => (
              <tr key={i} className="hover:bg-text-dim/[0.03]">
                <td className="border-border-dim text-text-dim w-12 border-b px-3 py-1 text-right">{i}</td>
                <td className="border-border-dim text-text-primary border-b px-3 py-1 break-all">{it}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (value.kind === 'hash') {
    const entries = Object.entries(value.value);
    return <KvTable rows={entries.map(([k, v]) => [k, v])} keyHead="field" valHead="value" />;
  }

  if (value.kind === 'zset') {
    const rows = value.value.map((r): [string, string] => [r.member, r.score]);
    return <KvTable rows={rows} keyHead="member" valHead="score" />;
  }

  if (value.kind === 'stream') {
    const entries = value.value;
    return (
      <div className="max-h-[60vh] space-y-2 overflow-auto">
        {entries.map((e) => (
          <div key={e.id} className="border-border-dim bg-bg-secondary rounded-lg border p-2">
            <div className="text-status-info/80 mb-1 font-mono text-[11px]">{e.id}</div>
            <KvTable rows={Object.entries(e.fields)} keyHead="field" valHead="value" />
          </div>
        ))}
      </div>
    );
  }

  return null;
}

function KvTable({ rows, keyHead, valHead }: { rows: [string, string][]; keyHead: string; valHead: string }) {
  return (
    <div className="border-border-dim bg-bg-secondary max-h-[60vh] overflow-auto rounded-lg border">
      <table className="w-full font-mono text-xs">
        <thead className="bg-bg-secondary sticky top-0">
          <tr>
            <th className="border-border-dim text-text-muted border-b px-3 py-2 text-left">{keyHead}</th>
            <th className="border-border-dim text-text-muted border-b px-3 py-2 text-left">{valHead}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([k, v], i) => (
            <tr key={i} className="hover:bg-text-dim/[0.03] align-top">
              <td className="border-border-dim text-accent/80 border-b px-3 py-1.5 whitespace-nowrap">{k}</td>
              <td className="border-border-dim text-text-primary border-b px-3 py-1.5">
                <Cell value={v} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
