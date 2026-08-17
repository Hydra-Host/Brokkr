import { useEffect, useRef, useState } from 'react';

import { parseSseEvent, StreamDoneEventSchema, streamPaths, TestEventSchema, type TestEvent } from '@/contract';
import { tsr } from '@/lib/api';
import { MAX_STREAM_RETRIES, STREAM_STABLE_MS } from '@/lib/reconnect';

import { withLabToken } from '@/lib/lab-token';
import { streamCompletedNormally } from '@/lib/use-log-stream';

const SOURCE_COLORS: Record<string, string> = {
  test: 'text-status-info',
  db: 'text-status-online',
  atom: 'text-status-purple',
  bmc: 'text-status-price',
  saga: 'text-status-info',
  api: 'text-status-warning',
  ssh: 'text-status-purple',
};

const LEVEL_STYLES: Record<string, string> = {
  info: 'text-text-muted',
  success: 'text-status-online',
  warn: 'text-status-warning',
  error: 'text-status-offline',
};

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function useEventStream(runId: string | null): {
  events: TestEvent[];
  degraded: boolean;
  disconnected: boolean;
} {
  const [events, setEvents] = useState<TestEvent[]>([]);
  // degraded: a reconnect is in flight. disconnected: the budget is spent and nothing is pending.
  const [degraded, setDegraded] = useState(false);
  const [disconnected, setDisconnected] = useState(false);

  useEffect(() => {
    setEvents([]);
    setDegraded(false);
    setDisconnected(false);
    if (!runId) return;

    let es: EventSource | null;
    let retries = 0;
    let openedAt = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const connect = () => {
      // EventSource can't set headers, so off-loopback auth rides the token query param (no-op on loopback).
      const source = new EventSource(withLabToken(streamPaths.testEvents(runId)));
      es = source;
      openedAt = 0;
      // per attempt: each (re)connect replays to the end and earns its own sentinel.
      done = false;
      // ignore handlers from a superseded connect or after teardown so a trailing event on a closed
      // EventSource can't clear the current timeline or corrupt retry state.
      const stale = () => disposed || es !== source;
      source.onopen = () => {
        if (stale()) return;
        openedAt = Date.now();
        // reset here (not in the reconnect timer) so a retry that never opens keeps the events on
        // screen; the backlog replay arrives only after open, so dedupe is unchanged.
        setEvents([]);
        setDegraded(false);
        setDisconnected(false);
      };
      source.onmessage = (e) => {
        if (stale()) return;
        if (parseSseEvent(StreamDoneEventSchema, e.data)) {
          // the run finished and the server is about to close — the close that follows is normal.
          done = true;
          return;
        }
        const evt = parseSseEvent(TestEventSchema, e.data);
        if (evt) setEvents((prev) => [...prev, evt]);
      };
      source.onerror = () => {
        source.close();
        if (stale()) return;
        // mark this source superseded (mirrors useLogStream nulling esRef): a trailing onerror on
        // the same closed source must not burn a second retry or stack a duplicate reconnect timer.
        es = null;
        const stableFor = openedAt > 0 ? Date.now() - openedAt : 0;
        if (stableFor > STREAM_STABLE_MS) retries = 0;
        // the events SSE is always a finite run stream (no infinite tail consumers).
        const completedNormally = streamCompletedNormally({ finite: true, done });
        const shouldRetry = !completedNormally && retries < MAX_STREAM_RETRIES;
        if (!shouldRetry) {
          setDegraded(false);
          // a completion on the last budgeted reconnect is a success, not an outage.
          setDisconnected(!completedNormally && retries >= MAX_STREAM_RETRIES);
          return;
        }
        retries += 1;
        if (retries >= 2) setDegraded(true);
        timer = setTimeout(connect, Math.min(500 * 2 ** (retries - 1), 10000));
      };
    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      es?.close();
    };
  }, [runId]);

  return { events, degraded, disconnected };
}

export function usePastEvents(runId: string | null): TestEvent[] {
  const q = tsr.listTestEvents.useQuery({
    queryKey: ['test-events', runId],
    queryData: { params: { runId: runId ?? '' } },
    enabled: !!runId,
    retry: false,
  });
  return q.data?.status === 200 ? q.data.body : [];
}

export function EventTimeline({ events, live }: { events: TestEvent[]; live?: boolean }) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && live) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events.length, autoScroll, live]);

  const handleScroll = () => {
    if (!containerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
  };

  if (events.length === 0) {
    return (
      <div className="text-text-dim flex h-full items-center justify-center text-xs">
        {live ? 'Waiting for events...' : 'No events recorded.'}
      </div>
    );
  }

  return (
    <div ref={containerRef} onScroll={handleScroll} className="h-full overflow-auto font-mono text-xs">
      <table className="w-full border-collapse">
        <thead className="bg-bg-primary sticky top-0">
          <tr className="text-text-dim text-[10px] tracking-wider uppercase">
            <th className="w-[70px] px-2 py-1 text-left">Time</th>
            <th className="w-[60px] px-2 py-1 text-left">Source</th>
            <th className="px-2 py-1 text-left">Message</th>
          </tr>
        </thead>
        <tbody>
          {events.map((evt) => (
            <tr key={evt.id} className="border-border-dim hover:bg-hover-bg border-t">
              <td className="text-text-dim px-2 py-1 whitespace-nowrap">{formatTime(evt.timestamp)}</td>
              <td className={`px-2 py-1 whitespace-nowrap ${SOURCE_COLORS[evt.source] ?? 'text-text-muted'}`}>
                {evt.source}
              </td>
              <td className={`px-2 py-1 ${LEVEL_STYLES[evt.level] ?? 'text-text-muted'}`}>{evt.message}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div ref={bottomRef} />
    </div>
  );
}
