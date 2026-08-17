import type { LifecycleJobEventRow } from '@/contract';
import { fmtAgo } from '@/lib/format';

import { eventSkewMs, groupSagaRuns } from './hub-status';

// past a day the two stamps are not on one clock, so the difference is evidence about the clock
// rather than a measurement of ingest lag
const IMPLAUSIBLE_SKEW_MS = 24 * 60 * 60 * 1000;

function SkewNote({ event }: { event: LifecycleJobEventRow }) {
  const skew = eventSkewMs(event);
  if (skew === null) {
    return (
      <span className="text-text-dim" title="the bridge sent no event time, so the ingest lag cannot be determined">
        no bridge time
      </span>
    );
  }
  if (Math.abs(skew) > IMPLAUSIBLE_SKEW_MS) {
    return (
      <span
        className="text-status-warning"
        title={`the bridge stamped this ${new Date(event.occurredAtMs ?? 0).toISOString()}, which is not on the hub's clock — a seconds value read as milliseconds lands in 1970`}
      >
        bridge time implausible
      </span>
    );
  }
  if (Math.abs(skew) < 1000) return null;
  return (
    <span className="text-text-dim" title="how far the hub's ingest trailed the bridge's own clock for this event">
      {skew > 0 ? '+' : ''}
      {Math.round(skew / 1000)}s ingest
    </span>
  );
}

function StepRow({ event, nowMs }: { event: LifecycleJobEventRow; nowMs: number }) {
  const failed = event.error !== null;
  return (
    <div className="border-border-dim/60 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b py-1 last:border-0">
      <span className={`font-mono text-[11px] ${failed ? 'text-status-offline' : 'text-text-primary'}`}>
        {event.stepName}
      </span>
      <span className="text-text-dim font-mono text-[10px]">{event.eventType}</span>
      <span className={`font-mono text-[11px] ${failed ? 'text-status-offline' : 'text-text-muted'}`}>
        {event.status}
      </span>
      {event.attempt > 0 && (
        <span className="text-status-warning/80 font-mono text-[10px]" title="attempts consumed on this step">
          ×{event.attempt + 1}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-baseline gap-2 font-mono text-[10px]">
        <SkewNote event={event} />
        <span className="text-text-dim">{fmtAgo(event.recordedAtMs, nowMs)}</span>
      </span>
      {failed && <div className="text-status-offline w-full font-mono text-[10px] break-words">{event.error}</div>}
    </div>
  );
}

export function SagaTimeline({ events, nowMs }: { events: readonly LifecycleJobEventRow[]; nowMs: number }) {
  const runs = groupSagaRuns(events);

  return (
    <div className="space-y-3">
      {runs.map((run, index) => (
        <div key={`${run.sagaName}-${index}`}>
          <div className="text-text-dim mb-0.5 flex items-baseline gap-2 font-mono text-[10px] tracking-wide uppercase">
            <span className="text-text-muted">{run.sagaName}</span>
            <span>
              {run.events.length} step{run.events.length === 1 ? '' : 's'}
            </span>
          </div>
          <div className="border-border-dim bg-bg-secondary rounded-lg border px-2">
            {run.events.map((event) => (
              <StepRow key={event.id} event={event} nowMs={nowMs} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
