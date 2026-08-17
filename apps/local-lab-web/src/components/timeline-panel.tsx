import { SectionHeading } from '@/components/console';
import { EventTimeline, useEventStream, usePastEvents } from '@/components/event-timeline';

export function TimelinePanel({ runId, isRunning }: { runId: string | null; isRunning: boolean }) {
  const live = useEventStream(isRunning ? runId : null);
  const pastEvents = usePastEvents(!isRunning ? runId : null);
  const events = isRunning ? live.events : pastEvents;
  const degraded = isRunning && live.degraded;
  const disconnected = isRunning && live.disconnected;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex items-center gap-2">
        <SectionHeading>Timeline</SectionHeading>
        {events.length > 0 && <span className="text-text-dim text-[11px]">{events.length} events</span>}
        {degraded && <span className="text-status-warning/80 text-[11px]">reconnecting…</span>}
        {disconnected && <span className="text-status-offline/80 text-[11px]">disconnected</span>}
      </div>
      <div className="border-border-dim bg-bg-primary min-h-[60vh] flex-1 overflow-hidden rounded-lg border p-2 lg:min-h-0">
        {runId ? (
          <EventTimeline events={events} live={isRunning} />
        ) : (
          <div className="text-text-dim flex h-full items-center justify-center text-sm">
            Pick a scenario to run, or select a past run to view its timeline.
          </div>
        )}
      </div>
    </div>
  );
}
