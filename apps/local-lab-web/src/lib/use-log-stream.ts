import { AnsiUp } from 'ansi_up';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { RefObject } from 'react';

import { LogLineEventSchema, parseSseEvent, StreamDoneEventSchema, streamPaths } from '@/contract';

import { withLabToken } from './lab-token';
import { MAX_STREAM_RETRIES, STREAM_STABLE_MS } from './reconnect';

export type LogRef = RefObject<HTMLPreElement | null>;

// One-shot fleet-run completion watcher on its own EventSource, so it survives the visible log pane
// switching streams (the shared pane's stream is replaced by any later open()).
export function awaitFleetRun(runId: string): Promise<void> {
  return new Promise((resolve) => {
    const es = new EventSource(withLabToken(streamPaths.run(runId)));
    const settle = () => {
      es.close();
      resolve();
    };
    es.onmessage = (e) => {
      if (parseSseEvent(StreamDoneEventSchema, e.data)) settle();
    };
    // a terminal close (unknown run, server gone) yields no sentinel — settle so verify still refreshes;
    // transient drops keep the browser's own retry.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) settle();
    };
  });
}

// Finite run streams end with a {done:true} sentinel; a close after it is normal completion, without it
// a drop worth retrying. Infinite tails never emit the sentinel, so any close on them is abnormal.
export function streamCompletedNormally(args: { finite: boolean; done: boolean }): boolean {
  return args.finite && args.done;
}

// Appends only the newly-grown suffix (never replaces innerHTML) so a live selection's text nodes
// survive; on divergence (shrink from clear()/new stream, or a changed head) it resets and repaints.
export function usePaintedHtml(ref: RefObject<HTMLElement | null>, html: string) {
  const HEAD = 256;
  const htmlRef = useRef(html);
  htmlRef.current = html;
  const paintedLen = useRef(0);
  const head = useRef('');

  const paint = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = htmlRef.current;
    const appendable = paintedLen.current > 0 && next.length >= paintedLen.current && next.startsWith(head.current);
    if (appendable) {
      if (next.length > paintedLen.current) el.insertAdjacentHTML('beforeend', next.slice(paintedLen.current));
    } else {
      el.replaceChildren();
      if (next) el.insertAdjacentHTML('beforeend', next);
    }
    head.current = next.slice(0, HEAD);
    paintedLen.current = next.length;
  }, [ref]);

  useLayoutEffect(() => {
    paint();
  }, [html, paint]);

  return useCallback(
    (el: HTMLElement | null) => {
      ref.current = el;
      paintedLen.current = 0;
      head.current = '';
      if (el) paint();
    },
    [ref, paint],
  );
}

const makeAnsi = () => {
  const a = new AnsiUp();
  a.use_classes = false;
  return a;
};

export function useLogStream() {
  const [logHtml, setLogHtml] = useState('');
  const [logText, setLogText] = useState('');
  const esRef = useRef<EventSource | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const htmlRef = useRef('');
  const flushedRef = useRef('');
  const textRef = useRef('');
  const flushedTextRef = useRef('');
  const ansiRef = useRef<AnsiUp | null>(null);
  const followRef = useRef(true);
  const [follow, setFollowState] = useState(true);

  // Bounded reconnect state (finiteRef selects the kind): a finite stream's close counts as done only
  // after the `{done:true}` sentinel; every other close (sentinel-less finite, or infinite tail) retries with backoff to the cap.
  const urlRef = useRef<string | null>(null);
  const finiteRef = useRef(true);
  const retriesRef = useRef(0);
  const openedAtRef = useRef(0);
  const doneRef = useRef(false);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // degraded: a reconnect is in flight. disconnected: the budget is spent and nothing is pending.
  const [degraded, setDegraded] = useState(false);
  const [disconnected, setDisconnected] = useState(false);

  const selectingHere = () => {
    const sel = window.getSelection();
    const el = logRef.current;
    return !!el && !!sel && !sel.isCollapsed && !!sel.anchorNode && el.contains(sel.anchorNode);
  };

  const flush = () => {
    if (htmlRef.current !== flushedRef.current) {
      flushedRef.current = htmlRef.current;
      setLogHtml(htmlRef.current);
    }
    if (textRef.current !== flushedTextRef.current) {
      flushedTextRef.current = textRef.current;
      setLogText(textRef.current);
    }
  };

  const clearReconnect = () => {
    if (reconnectRef.current) {
      clearTimeout(reconnectRef.current);
      reconnectRef.current = null;
    }
  };

  // Flush buffered output once the user finishes/clears a selection.
  useEffect(() => {
    const onSelChange = () => !selectingHere() && flush();
    document.addEventListener('selectionchange', onSelChange);
    return () => {
      document.removeEventListener('selectionchange', onSelChange);
      clearReconnect();
      esRef.current?.close();
    };
  }, []);

  const setFollow = (v: boolean) => {
    followRef.current = v;
    setFollowState(v);
    if (v && logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  };

  useEffect(() => {
    const el = logRef.current;
    if (!el || selectingHere() || !followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [logHtml]);

  // Reset the render buffer — the run-stream routes replay their full backlog on every (re)connect, so
  // reusing the buffer across a reconnect would double it.
  const resetBuffer = () => {
    ansiRef.current = makeAnsi();
    htmlRef.current = '';
    flushedRef.current = '';
    setLogHtml('');
    textRef.current = '';
    flushedTextRef.current = '';
    setLogText('');
  };

  const connect = () => {
    const url = urlRef.current;
    if (!url) return;
    // EventSource can't set headers, so off-loopback auth rides the token query param (no-op on loopback).
    const es = new EventSource(withLabToken(url));
    openedAtRef.current = 0;
    // per attempt: each (re)connect replays to the end and earns its own sentinel.
    doneRef.current = false;
    es.onopen = () => {
      // ignore a handler from a superseded/closed stream (rapid reopen, or a trailing error on a
      // closed EventSource) so it can't reset the buffer or retry state of the current one.
      if (esRef.current !== es) return;
      openedAtRef.current = Date.now();
      // reset the buffer here (not in the reconnect timer) so a retry that never opens leaves the
      // last output on screen; the backlog replay arrives only after open, so dedupe is unchanged.
      resetBuffer();
      setDegraded(false);
      setDisconnected(false);
    };
    es.onmessage = (e) => {
      if (esRef.current !== es) return;
      if (parseSseEvent(StreamDoneEventSchema, e.data)) {
        // the run finished and the server is about to close — the close that follows is normal.
        doneRef.current = true;
        return;
      }
      const frame = parseSseEvent(LogLineEventSchema, e.data);
      if (!frame) return;
      htmlRef.current += ansiRef.current!.ansi_to_html(frame.line);
      textRef.current += frame.line;
      if (!selectingHere()) flush();
    };
    es.onerror = () => {
      if (esRef.current !== es) return;
      es.close();
      esRef.current = null;
      const opened = openedAtRef.current > 0;
      const stableFor = opened ? Date.now() - openedAtRef.current : 0;
      if (stableFor > STREAM_STABLE_MS) retriesRef.current = 0; // recovered and ran a while — fresh budget
      const completedNormally = streamCompletedNormally({ finite: finiteRef.current, done: doneRef.current });
      const shouldRetry = !completedNormally && retriesRef.current < MAX_STREAM_RETRIES;
      if (!shouldRetry) {
        // spent budget = terminal disconnect, but only if the stream did NOT complete normally (a run that
        // finishes on the last budgeted reconnect — budget never refreshed — is a success, not an outage).
        setDegraded(false);
        setDisconnected(!completedNormally && retriesRef.current >= MAX_STREAM_RETRIES);
        return;
      }
      retriesRef.current += 1;
      // Don't flag a single, self-healing blip; surface degraded once a reconnect has itself failed.
      if (retriesRef.current >= 2) setDegraded(true);
      reconnectRef.current = setTimeout(connect, Math.min(500 * 2 ** (retriesRef.current - 1), 10000));
    };
    esRef.current = es;
  };

  // finite (default) = a run stream that completes after replaying its backlog; infinite = a
  // process/service log tail the server never closes on its own, so every drop is retried.
  const open = (url: string, opts?: { finite?: boolean }) => {
    clearReconnect();
    esRef.current?.close();
    resetBuffer();
    // Each open() resets follow + the retry budget — the hook persists across stream switches.
    followRef.current = true;
    setFollowState(true);
    retriesRef.current = 0;
    setDegraded(false);
    setDisconnected(false);
    urlRef.current = url;
    finiteRef.current = opts?.finite ?? true;
    connect();
  };

  const close = () => {
    clearReconnect();
    esRef.current?.close();
    esRef.current = null;
    urlRef.current = null;
    // an intentional close is not an outage — don't leave a stale degraded/disconnected chip up.
    setDegraded(false);
    setDisconnected(false);
  };

  // Clears without closing the stream; the AnsiUp parser must reset too or mid-stream colors leak across clear.
  const clear = () => {
    htmlRef.current = '';
    flushedRef.current = '';
    setLogHtml('');
    textRef.current = '';
    flushedTextRef.current = '';
    setLogText('');
    if (ansiRef.current) ansiRef.current = makeAnsi();
  };

  return { logHtml, logText, logRef, open, close, clear, follow, setFollow, degraded, disconnected };
}
