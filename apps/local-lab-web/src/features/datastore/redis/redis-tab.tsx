import { useEffect, useMemo, useState } from 'react';

import { SectionHeading } from '@/components/console';
import type { RedisKey } from '@/contract';
import {
  ErrorBanner,
  errText,
  useDatastoreSearch,
  useParamDraft,
  useSetDatastoreSearch,
} from '@/features/datastore/shared';
import { tsr } from '@/lib/api';
import { bodyError, thrownBodyError } from '@/lib/errors';

import { RedisMetadata } from './redis-metadata';
import { RedisValuePanel } from './redis-value';
import { TYPE_COLOR } from './type-color';

const DEFAULT_MATCH = '*';

export function RedisTab() {
  const info = tsr.getRedisInfo.useQuery({ queryKey: ['redis-info'], refetchInterval: 5000 });
  const { key: selected, match: matchParam } = useDatastoreSearch();
  const setSearch = useSetDatastoreSearch();
  const { draft: match, setDraft: setMatch, markSent } = useParamDraft(matchParam ?? DEFAULT_MATCH);
  const [pattern, setPattern] = useState('');
  const [cursor, setCursor] = useState('0');
  const [keys, setKeys] = useState<RedisKey[]>([]);
  const [scanErr, setScanErr] = useState('');
  const [scanning, setScanning] = useState(false);

  const infoBody = info.data?.status === 200 ? info.data.body : null;
  const infoErr = errText(info.data, info.error);

  const doScan = (reset: boolean) => {
    setScanErr('');
    setScanning(true);
    const startCursor = reset ? '0' : cursor;
    const usePattern = reset ? match.trim() : pattern;
    void tsr.scanRedisKeys
      .query({ query: { cursor: startCursor, match: usePattern || undefined, count: 200 } })
      .then((res) => {
        if (res.status !== 200) {
          setScanErr(bodyError(res.body) ?? 'scan failed');
          return;
        }
        setCursor(res.body.cursor);
        setPattern(usePattern);
        setKeys((prev) => (reset ? res.body.keys : [...prev, ...res.body.keys]));
      })
      .catch((err: unknown) => setScanErr(thrownBodyError(err) ?? String(err)))
      .finally(() => setScanning(false));
  };

  const scanNow = () => {
    const next = match.trim();
    markSent(next || DEFAULT_MATCH);
    setSearch({ match: next && next !== DEFAULT_MATCH ? next : undefined });
    doScan(true);
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => doScan(true), []);

  const grouped = useMemo(() => groupKeys(keys), [keys]);

  return (
    <div className="space-y-4">
      {infoErr ? <ErrorBanner>{infoErr}</ErrorBanner> : <RedisMetadata info={infoBody} />}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr]">
        <div className="space-y-2">
          <SectionHeading>Keys</SectionHeading>
          <div className="flex gap-2">
            <input
              value={match}
              onChange={(e) => setMatch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && scanNow()}
              placeholder="MATCH e.g. *:device:*"
              className="border-border-dim bg-bg-primary text-text-primary focus:border-accent/50 flex-1 rounded border px-2 py-1 font-mono text-xs outline-none"
            />
            <button
              onClick={scanNow}
              disabled={scanning}
              className="bg-accent/20 text-accent hover:bg-accent/30 rounded-md px-3 py-1 text-xs disabled:opacity-40"
            >
              Scan
            </button>
          </div>
          {scanErr && <ErrorBanner>{scanErr}</ErrorBanner>}
          <div className="max-h-[65vh] space-y-2 overflow-auto pr-1">
            {grouped.map((g) => (
              <div key={g.prefix}>
                {g.prefix && (
                  <div className="text-text-dim px-1 py-0.5 text-[10px] tracking-wide uppercase">{g.prefix}</div>
                )}
                <div className="space-y-0.5">
                  {g.keys.map((k) => (
                    <button
                      key={k.key}
                      onClick={() => setSearch({ key: k.key })}
                      className={[
                        'flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11px]',
                        selected === k.key ? 'bg-accent/15 text-accent' : 'text-text-muted hover:bg-hover-bg',
                      ].join(' ')}
                    >
                      <span className={`shrink-0 ${TYPE_COLOR[k.type] ?? 'text-text-dim'}`}>{k.type}</span>
                      <span className="truncate">{g.prefix ? k.key.slice(g.prefix.length + 1) : k.key}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {keys.length === 0 && !scanning && <div className="text-text-dim px-1 text-xs">no keys — run a scan</div>}
          </div>
          {cursor !== '0' && (
            <button
              onClick={() => doScan(false)}
              disabled={scanning}
              className="border-border-dim text-text-muted hover:bg-hover-bg w-full rounded-md border border-dashed px-3 py-1.5 text-xs disabled:opacity-40"
            >
              {scanning ? 'scanning…' : `load more (cursor ${cursor})`}
            </button>
          )}
        </div>

        <div className="min-w-0">
          {selected ? (
            <RedisValuePanel keyName={selected} />
          ) : (
            <div className="text-text-dim text-sm">select a key to view its value.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function groupKeys(keys: RedisKey[]): { prefix: string; keys: RedisKey[] }[] {
  const map = new Map<string, RedisKey[]>();
  for (const k of keys) {
    const segs = k.key.split(':');
    const prefix = segs.length >= 3 ? segs.slice(0, 2).join(':') : '';
    if (!map.has(prefix)) map.set(prefix, []);
    map.get(prefix)!.push(k);
  }
  return [...map.entries()].map(([prefix, ks]) => ({ prefix, keys: ks }));
}
