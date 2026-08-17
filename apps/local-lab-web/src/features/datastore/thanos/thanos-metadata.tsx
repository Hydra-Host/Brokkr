import { useState } from 'react';

import type { ThanosStatus } from '@/contract';
import { Tile } from '@/features/datastore/shared';

export function ThanosMetadata({ status, metricCount }: { status: ThanosStatus | null; metricCount: number | null }) {
  const [showStores, setShowStores] = useState(false);
  if (!status) return <div className="text-text-dim text-xs">loading…</div>;
  const healthy = status.stores.filter((s) => !s.lastError).length;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="Query" value={`thanos ${status.version}`} />
        <Tile label="Metric names" value={metricCount === null ? '—' : metricCount.toLocaleString()} />
        <Tile
          label="Stores"
          value={`${healthy} / ${status.stores.length}`}
          sub={status.stores.length === 0 ? 'no stores' : healthy === status.stores.length ? 'all healthy' : 'degraded'}
        />
      </div>
      {status.stores.length > 0 && (
        <div className="border-border-dim bg-bg-secondary rounded-lg border p-3">
          <button
            onClick={() => setShowStores((s) => !s)}
            className="text-text-dim flex items-center gap-1.5 text-[10px] tracking-wide uppercase"
          >
            <span>{showStores ? '▾' : '▸'}</span>
            StoreAPI endpoints · {status.stores.length}
          </button>
          {showStores && (
            <div className="mt-3 max-h-56 overflow-auto">
              <table className="text-text-primary w-full font-mono text-[11px]">
                <thead className="text-text-dim text-left">
                  <tr>
                    <th className="py-1 pr-3 font-normal">type</th>
                    <th className="py-1 pr-3 font-normal">endpoint</th>
                    <th className="py-1 pr-3 font-normal">min time</th>
                    <th className="py-1 pr-3 font-normal">max time</th>
                    <th className="py-1 font-normal">status</th>
                  </tr>
                </thead>
                <tbody>
                  {status.stores.map((s) => (
                    <tr key={`${s.type}:${s.name}`} className="border-border-dim border-t">
                      <td className="text-accent/80 py-1 pr-3">{s.type}</td>
                      <td className="py-1 pr-3">{s.name}</td>
                      <td className="text-text-muted py-1 pr-3">{s.minTime}</td>
                      <td className="text-text-muted py-1 pr-3">{s.maxTime}</td>
                      <td className={`py-1 ${s.lastError ? 'text-status-offline' : 'text-status-online/80'}`}>
                        {s.lastError ?? 'ok'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
