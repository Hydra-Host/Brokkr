import { useState } from 'react';

import type { RedisInfo } from '@/contract';
import { Tile } from '@/features/datastore/shared';

function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (parts.length < 2) parts.push(`${m}m`);
  return parts.join(' ');
}

function hitRatio(server: Record<string, string>): string {
  const h = Number(server.keyspace_hits ?? 0);
  const m = Number(server.keyspace_misses ?? 0);
  const total = h + m;
  if (!total) return '—';
  return `${((h / total) * 100).toFixed(1)}%`;
}

export function RedisMetadata({ info }: { info: RedisInfo | null }) {
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  if (!info) return <div className="text-text-dim text-xs">loading…</div>;
  const s = info.server;
  const uptime = formatUptime(Number(s.uptime_in_seconds ?? 0));
  const memUsed = s.used_memory_human ?? '—';
  const memMax = s.maxmemory_human && s.maxmemory_human !== '0B' ? s.maxmemory_human : '∞';
  const ops = s.instantaneous_ops_per_sec ?? '0';
  const totalCmd = s.total_commands_processed ?? '0';
  const connected = s.connected_clients ?? '0';
  const totalRecv = s.total_connections_received ?? '0';
  const maxClients = s.maxclients ?? '—';
  const rejected = s.rejected_connections;
  const role = s.role ?? 'unknown';
  const evicted = s.evicted_keys;
  const expired = s.expired_keys;
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Tile label="Server" value={`redis ${s.redis_version ?? '?'}`} sub={`${role} · up ${uptime}`} />
        <Tile label="Throughput" value={`${ops} ops/sec`} sub={`${Number(totalCmd).toLocaleString()} total commands`} />
        <Tile
          label="Memory"
          value={`${memUsed} / ${memMax}`}
          sub={`hit ratio ${hitRatio(s)}${evicted && evicted !== '0' ? ` · ${evicted} evicted` : ''}${expired && expired !== '0' ? ` · ${expired} expired` : ''}`}
        />
        <Tile
          label="Connections"
          value={`${connected} / ${maxClients}`}
          sub={`${Number(totalRecv).toLocaleString()} since boot${rejected && rejected !== '0' ? ` · ${rejected} rejected` : ''}`}
        />
        <Tile label="Keys (db0)" value={info.dbsize.toLocaleString()} />
      </div>

      {info.clients.length > 0 && (
        <div className="border-border-dim bg-bg-secondary rounded-lg border p-3">
          <div className="text-text-dim mb-2 text-[10px] tracking-wide uppercase">Connections by client</div>
          <div className="flex flex-wrap gap-1.5">
            {info.clients.map((g) => {
              const open = expandedGroup === g.label;
              return (
                <button
                  key={g.label}
                  onClick={() => setExpandedGroup(open ? null : g.label)}
                  className={[
                    'rounded-md border px-2 py-1 font-mono text-[11px] transition',
                    open
                      ? 'border-accent/50 bg-accent/10 text-accent'
                      : 'border-border-dim text-text-muted hover:bg-hover-bg',
                  ].join(' ')}
                >
                  <span className="text-text-primary">{g.label || '(unnamed)'}</span>
                  <span className="text-text-muted ml-1.5">×{g.count}</span>
                </button>
              );
            })}
          </div>
          {expandedGroup && (
            <div className="mt-3 max-h-56 overflow-auto">
              <table className="text-text-primary w-full font-mono text-[11px]">
                <thead className="text-text-dim text-left">
                  <tr>
                    <th className="py-1 pr-3 font-normal">id</th>
                    <th className="py-1 pr-3 font-normal">addr</th>
                    <th className="py-1 pr-3 font-normal">db</th>
                    <th className="py-1 pr-3 font-normal">age</th>
                    <th className="py-1 pr-3 font-normal">idle</th>
                    <th className="py-1 font-normal">last cmd</th>
                  </tr>
                </thead>
                <tbody>
                  {info.clients
                    .find((g) => g.label === expandedGroup)
                    ?.clients.map((c) => (
                      <tr key={c.id} className="border-border-dim border-t">
                        <td className="text-text-muted py-1 pr-3">{c.id}</td>
                        <td className="py-1 pr-3">{c.addr}</td>
                        <td className="text-text-muted py-1 pr-3">{c.db}</td>
                        <td className="text-text-muted py-1 pr-3">{formatUptime(c.ageSeconds)}</td>
                        <td className="text-text-muted py-1 pr-3">{c.idleSeconds}s</td>
                        <td className="text-text-muted py-1">{c.cmd || '—'}</td>
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
