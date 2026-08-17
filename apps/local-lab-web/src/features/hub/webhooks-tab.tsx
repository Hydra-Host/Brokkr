import { Unknown } from '@/components/ui/unknown';
import type { WebhookDeliveryRow } from '@/contract';
import { DELIVERY_STATUSES } from '@/contract';
import { fmtAgo } from '@/lib/format';
import type { HubSearch } from '@/lib/hub-search';

import { HubTable, ListState, NoRows } from './hub-shell';
import { DELIVERY_TONE, isDeliveryLockStale } from './hub-status';
import { useWebhookDeliveries } from './use-hub';

const COLUMNS = ['status', 'event', 'endpoint', 'http', 'attempts', 'lock', 'response', 'created'] as const;

function LockCell({ row, nowMs }: { row: WebhookDeliveryRow; nowMs: number }) {
  if (row.lockedBy === null) return <span className="text-text-dim">—</span>;
  const stale = isDeliveryLockStale(row, nowMs);
  return (
    <span
      className={stale ? 'text-status-offline' : 'text-status-info'}
      title={
        stale
          ? 'the processing lock is held past its expiry — this delivery is wedged, not in flight'
          : 'a worker holds the processing lock'
      }
    >
      {row.lockedBy}
      {stale && ' (stale)'}
    </span>
  );
}

export function WebhooksTab({
  search,
  setSearch,
  nowMs = Date.now(),
}: {
  search: HubSearch;
  setSearch: (patch: Partial<HubSearch>) => void;
  nowMs?: number;
}) {
  const { page, error, isPending } = useWebhookDeliveries(search.deliveryStatus, search.webhookId);

  return (
    <div data-tour="hub-webhooks" className="space-y-3">
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span className="text-text-dim mr-1 text-[10px] tracking-wide uppercase">status</span>
        <button
          onClick={() => setSearch({ deliveryStatus: undefined })}
          className={`border-border-dim rounded border px-2 py-0.5 ${search.deliveryStatus === undefined ? 'text-text-primary border-accent' : 'text-text-dim'}`}
        >
          all
        </button>
        {DELIVERY_STATUSES.map((status) => (
          <button
            key={status}
            onClick={() => setSearch({ deliveryStatus: status })}
            className={`border-border-dim rounded border px-2 py-0.5 ${search.deliveryStatus === status ? 'text-text-primary border-accent' : 'text-text-dim'}`}
          >
            {status.toLowerCase()}
          </button>
        ))}
      </div>

      <ListState error={error} readError={page?.readError} skipped={page?.skipped} isPending={isPending}>
        <HubTable columns={COLUMNS}>
          {page && page.rows.length === 0 && <NoRows span={COLUMNS.length}>no deliveries match</NoRows>}
          {page?.rows.map((row) => (
            <tr key={row.id} className="border-border-dim border-b last:border-0">
              <td className={`px-2 py-1.5 ${DELIVERY_TONE[row.status]}`}>{row.status.toLowerCase()}</td>
              <td className="text-text-muted px-2 py-1.5">{row.eventType}</td>
              <td className="text-text-muted max-w-[28ch] truncate px-2 py-1.5" title={row.endpoint ?? undefined}>
                {row.endpoint ?? <Unknown title="the parent webhook row is gone; its signing secret is never read" />}
              </td>
              <td className="px-2 py-1.5">
                {row.httpStatus ?? <Unknown title="the attempt never got a response, which is not a zero status" />}
              </td>
              <td className="text-text-muted px-2 py-1.5">{row.attempts}</td>
              <td className="px-2 py-1.5">
                <LockCell row={row} nowMs={nowMs} />
              </td>
              <td className="text-text-muted max-w-[24ch] truncate px-2 py-1.5" title={row.responseBody ?? undefined}>
                {row.responseBody === null ? (
                  <span className="text-text-dim">—</span>
                ) : (
                  `${row.responseBody}${row.responseBodyTruncated ? ' …[cut]' : ''}`
                )}
              </td>
              <td className="text-text-dim px-2 py-1.5">{fmtAgo(row.createdAtMs, nowMs)}</td>
            </tr>
          ))}
        </HubTable>
      </ListState>
    </div>
  );
}
