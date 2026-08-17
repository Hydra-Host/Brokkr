import type { QueueSummary } from '@/contract';

import {
  QUEUE_COUNT_COLUMNS,
  type QueueAddress,
  countTone,
  isQueueUnreadable,
  queueId,
  sameQueue,
} from './queue-health';

const COLUMN_LABEL: Record<string, string> = {
  'waiting-children': 'w-child',
  prioritized: 'prio',
};

const UNREADABLE_SPAN = QUEUE_COUNT_COLUMNS.length + 2;

const WORKERS_UNKNOWN_HINT = 'worker probe failed — the count could not be determined, which is not zero workers';
const PAUSED_UNKNOWN_HINT = 'pause probe failed — the pause state could not be determined, which is not "not paused"';

export function QueueTable({
  queues,
  selected,
  onSelect,
  placeholder,
}: {
  queues: readonly QueueSummary[];
  selected: QueueAddress | null;
  onSelect: (queue: QueueSummary) => void;
  placeholder: string;
}) {
  if (queues.length === 0) return <div className="text-text-dim px-1 py-2 text-xs">{placeholder}</div>;

  return (
    <div className="border-border-dim bg-bg-secondary max-h-[40vh] overflow-auto rounded-lg border">
      <table className="w-full font-mono text-[11px]">
        <thead className="bg-bg-secondary sticky top-0">
          <tr className="text-text-muted">
            <th className="border-border-dim border-b px-3 py-2 text-left font-normal">queue</th>
            <th className="border-border-dim border-b px-2 py-2 text-left font-normal">kind</th>
            {QUEUE_COUNT_COLUMNS.map((column) => (
              <th key={column} className="border-border-dim border-b px-2 py-2 text-right font-normal">
                {COLUMN_LABEL[column] ?? column}
              </th>
            ))}
            <th className="border-border-dim border-b px-2 py-2 text-right font-normal">stalled</th>
            <th className="border-border-dim border-b px-2 py-2 text-right font-normal">workers</th>
          </tr>
        </thead>
        <tbody>
          {queues.map((queue) => (
            <QueueRow
              key={queueId(queue)}
              queue={queue}
              active={sameQueue(queue, selected)}
              onSelect={() => onSelect(queue)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function QueueRow({ queue, active, onSelect }: { queue: QueueSummary; active: boolean; onSelect: () => void }) {
  const unreadable = isQueueUnreadable(queue);
  return (
    <tr
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={[
        'cursor-pointer border-l-2',
        unreadable ? 'border-l-status-offline bg-status-offline/10' : 'border-l-transparent',
        active ? 'bg-accent/10' : 'hover:bg-text-dim/[0.04]',
      ].join(' ')}
    >
      <td className="border-border-dim border-b px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className={active ? 'text-accent' : 'text-text-primary'}>{queue.name}</span>
          {queue.paused === true && <span className="text-status-warning/80 text-[10px] uppercase">paused</span>}
          {queue.paused === null && (
            <span className="text-status-warning/60 text-[10px] uppercase" title={PAUSED_UNKNOWN_HINT}>
              paused?
            </span>
          )}
        </div>
        <div className="text-text-dim truncate text-[10px]" title={queue.prefix}>
          {queue.prefix}
        </div>
      </td>
      <td className="border-border-dim text-text-muted border-b px-2 py-1.5">{queue.kind}</td>
      {unreadable ? (
        <td className="border-border-dim border-b px-2 py-1.5" colSpan={UNREADABLE_SPAN}>
          <span className="text-status-offline">
            <span className="mr-1.5 text-[10px] tracking-wide uppercase">unreadable</span>
            {queue.readError}
          </span>
          <div className="text-status-offline/70 text-[10px]">counts unavailable — this row is not an empty queue</div>
        </td>
      ) : (
        <>
          {QUEUE_COUNT_COLUMNS.map((column) => (
            <td
              key={column}
              className={`border-border-dim border-b px-2 py-1.5 text-right ${countTone(column, queue.counts[column])}`}
            >
              {queue.counts[column]}
            </td>
          ))}
          <td className={`border-border-dim border-b px-2 py-1.5 text-right ${countTone('stalled', queue.stalled)}`}>
            {queue.stalled}
          </td>
          <td className="border-border-dim text-text-muted border-b px-2 py-1.5 text-right">
            {queue.workers === null ? (
              <span className="text-status-warning/70" title={WORKERS_UNKNOWN_HINT}>
                ?
              </span>
            ) : (
              queue.workers
            )}
          </td>
        </>
      )}
    </tr>
  );
}
