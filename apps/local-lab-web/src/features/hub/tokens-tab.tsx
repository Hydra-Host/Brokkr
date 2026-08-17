import { Unknown } from '@/components/ui/unknown';
import type { DeviceTokenRow } from '@/contract';
import { DEVICE_TOKEN_STATUSES } from '@/contract';
import { fmtAgo } from '@/lib/format';
import type { HubSearch } from '@/lib/hub-search';

import { HubTable, ListState, NoRows } from './hub-shell';
import { ALARMING_TOKEN_EVENTS, RECENCY_LABEL, RECENCY_TITLE, tokenRecency } from './hub-status';
import { useDeviceTokenEvents, useDeviceTokens } from './use-hub';

const COLUMNS = ['token', 'context', 'status', 'last used', 'from'] as const;

function RecencyCell({ row, nowMs }: { row: DeviceTokenRow; nowMs: number }) {
  const recency = tokenRecency(row);
  if (recency === 'unknown') return <Unknown title={RECENCY_TITLE.unknown} />;
  if (recency === 'never')
    return (
      <span className="text-text-dim" title={RECENCY_TITLE.never}>
        never used
      </span>
    );
  if (recency === 'live') {
    return (
      <span className="text-status-online" title={RECENCY_TITLE.live}>
        {RECENCY_LABEL.live}
      </span>
    );
  }
  return (
    <span className="text-text-muted" title={RECENCY_TITLE.recent}>
      {row.lastUsedAtMs === null ? <Unknown title={RECENCY_TITLE.unknown} /> : fmtAgo(row.lastUsedAtMs, nowMs)}
    </span>
  );
}

function TokenEvents({ tokenId, nowMs }: { tokenId: string; nowMs: number }) {
  const { page, error, isPending } = useDeviceTokenEvents(tokenId);

  return (
    <ListState error={error} readError={page?.readError} skipped={page?.skipped} isPending={isPending}>
      <HubTable columns={['event', 'from', 'when']}>
        {page && page.rows.length === 0 && <NoRows span={3}>no audit events</NoRows>}
        {page?.rows.map((event) => (
          <tr key={event.id} className="border-border-dim border-b last:border-0">
            <td
              className={`px-2 py-1.5 ${ALARMING_TOKEN_EVENTS.has(event.event) ? 'text-status-offline' : 'text-text-muted'}`}
              title={
                ALARMING_TOKEN_EVENTS.has(event.event)
                  ? 'something still holds a token it should no longer be able to use'
                  : undefined
              }
            >
              {event.event}
            </td>
            <td className="text-text-dim px-2 py-1.5">{event.ip ?? '—'}</td>
            <td className="text-text-dim px-2 py-1.5">{fmtAgo(event.createdAtMs, nowMs)}</td>
          </tr>
        ))}
      </HubTable>
    </ListState>
  );
}

export function TokensTab({
  search,
  setSearch,
  nowMs = Date.now(),
}: {
  search: HubSearch;
  setSearch: (patch: Partial<HubSearch>) => void;
  nowMs?: number;
}) {
  const { page, error, isPending } = useDeviceTokens(search.deviceId, search.tokenStatus);

  return (
    <div data-tour="hub-tokens" className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_24rem]">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-text-dim mr-1 text-[10px] tracking-wide uppercase">status</span>
          <button
            onClick={() => setSearch({ tokenStatus: undefined })}
            className={`border-border-dim rounded border px-2 py-0.5 ${search.tokenStatus === undefined ? 'text-text-primary border-accent' : 'text-text-dim'}`}
          >
            all
          </button>
          {DEVICE_TOKEN_STATUSES.map((status) => (
            <button
              key={status}
              onClick={() => setSearch({ tokenStatus: status })}
              className={`border-border-dim rounded border px-2 py-0.5 ${search.tokenStatus === status ? 'text-text-primary border-accent' : 'text-text-dim'}`}
            >
              {status.toLowerCase()}
            </button>
          ))}
          {search.deviceId && (
            <button
              onClick={() => setSearch({ deviceId: undefined })}
              className="border-accent/30 text-accent ml-auto rounded border px-2 py-0.5"
              title="clear the device filter this page was opened with"
            >
              device {search.deviceId.slice(-6)} ✕
            </button>
          )}
        </div>

        {page?.recencyReadError && (
          <div className="text-status-warning text-[11px]" title={RECENCY_TITLE.unknown}>
            recency probe unavailable — {page.recencyReadError}
          </div>
        )}

        <ListState error={error} readError={page?.readError} skipped={page?.skipped} isPending={isPending}>
          <HubTable columns={COLUMNS}>
            {page && page.rows.length === 0 && <NoRows span={COLUMNS.length}>no tokens match</NoRows>}
            {page?.rows.map((row) => (
              <tr
                key={row.id}
                onClick={() => setSearch({ tokenId: row.id })}
                className={`border-border-dim hover:bg-hover-bg cursor-pointer border-b last:border-0 ${
                  search.tokenId === row.id ? 'bg-hover-bg' : ''
                }`}
              >
                <td className="text-text-primary px-2 py-1.5">{row.displayId}</td>
                <td className="text-text-muted px-2 py-1.5">{row.context}</td>
                <td className={`px-2 py-1.5 ${row.status === 'ACTIVE' ? 'text-status-online' : 'text-text-dim'}`}>
                  {row.status.toLowerCase()}
                </td>
                <td className="px-2 py-1.5">
                  <RecencyCell row={row} nowMs={nowMs} />
                </td>
                <td className="text-text-dim px-2 py-1.5">{row.lastUsedIp ?? '—'}</td>
              </tr>
            ))}
          </HubTable>
        </ListState>
      </div>

      <div className="space-y-2">
        <div className="text-text-dim text-[10px] tracking-wide uppercase">audit trail</div>
        {search.tokenId ? (
          <TokenEvents tokenId={search.tokenId} nowMs={nowMs} />
        ) : (
          <div className="text-text-dim text-xs">select a token to see its audit trail</div>
        )}
      </div>
    </div>
  );
}
