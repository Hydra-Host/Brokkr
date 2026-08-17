import type { ThanosQueryResult } from '@/contract';

export function ThanosResultTable({ result }: { result: ThanosQueryResult }) {
  if (result.samples.length === 0) return <div className="text-text-dim text-sm">no data</div>;
  return (
    <div className="border-border-dim bg-bg-secondary overflow-auto rounded-lg border">
      <table className="w-full border-collapse font-mono text-xs">
        <thead className="bg-bg-secondary sticky top-0">
          <tr>
            <th className="border-border-dim border-b px-3 py-2 text-left">
              <span className="text-text-primary">series</span>
            </th>
            <th className="border-border-dim border-b px-3 py-2 text-right">
              <span className="text-text-primary">value</span>
            </th>
            <th className="border-border-dim border-b px-3 py-2 text-left whitespace-nowrap">
              <span className="text-text-primary">time</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {result.samples.map((s, i) => (
            <tr key={i} className="hover:bg-text-dim/[0.03] align-top">
              <td className="border-border-dim border-b px-3 py-1.5">
                <SeriesLabels metric={s.metric} />
              </td>
              <td className="border-border-dim text-status-online/90 border-b px-3 py-1.5 text-right whitespace-nowrap">
                {s.value}
              </td>
              <td className="border-border-dim text-text-dim border-b px-3 py-1.5 whitespace-nowrap">
                {formatSampleTime(s.timestamp)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeriesLabels({ metric }: { metric: Record<string, string> }) {
  const { __name__: name, ...labels } = metric;
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return (
    <span className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      {name && <span className="text-accent">{name}</span>}
      {entries.map(([k, v]) => (
        <span key={k} className="text-text-muted">
          <span className="text-text-dim">{k}=</span>
          <span className="text-status-info/80">&quot;{v}&quot;</span>
        </span>
      ))}
      {!name && entries.length === 0 && <span className="text-text-dim italic">(scalar)</span>}
    </span>
  );
}

function formatSampleTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '—';
  return new Date(unixSeconds * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}
