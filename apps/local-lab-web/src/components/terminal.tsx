import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon, type ISearchOptions, type ISearchResultChangeEvent } from '@xterm/addon-search';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';

import { ConsoleControls } from '@/components/console';
import { streamPaths, WS_TOKEN_PROTOCOL } from '@/contract';
import { tsr } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { MAX_STREAM_RETRIES, STREAM_STABLE_MS } from '@/lib/reconnect';
import { useHostToken } from '@/lib/use-host-token';
import { usePoll } from '@/lib/use-poll';

const TERM_OPTS = {
  fontSize: 13,
  fontFamily: 'ui-monospace, monospace',
  theme: { background: '#0b0e14', foreground: '#d7dce5' },
  scrollback: 50000,
};

const HISTORY_TAIL_BYTES = 1_048_576;

const SEARCH_OPTS: ISearchOptions = {
  decorations: {
    matchBackground: '#5b4a00',
    activeMatchBackground: '#b58900',
    matchOverviewRuler: '#b58900',
    activeMatchColorOverviewRuler: '#ffd700',
  },
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

// WS protocol: server → raw output, written verbatim so ANSI colors and redraws render;
// client → {i:keystrokes} / {r:[cols,rows]} resizes.
export function Xterm({ path }: { path: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const gate = useHostToken('An interactive console');
  const { token, blocked, ask } = gate;

  const getText = () => {
    const term = termRef.current;
    if (!term) return '';
    const buf = term.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n').replace(/\n+$/, '') + '\n';
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host || blocked) return;

    const term = new Terminal({ ...TERM_OPTS, cursorBlink: true });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}${path}`;
    // the ws token is a subprotocol, never a query param: the lab refuses ?token= on an upgrade because
    // it lands in every access log on the way there.
    const protocols = token ? [WS_TOKEN_PROTOCOL, token] : undefined;
    let ws: WebSocket | undefined;
    let retries = 0;
    let openedAt = 0; // set in onopen; onclose refreshes the budget only if the socket stayed up
    let everOpened = false; // a socket refused for want of the capability never opens even once
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false; // set on unmount so a pending reconnect never revives the socket

    const sendResize = () =>
      ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ r: [term.cols, term.rows] }));

    const connect = () => {
      // reset per attempt: a failed reconnect must not read the PREVIOUS session's open time, or a
      // once-stable console would refresh the budget on every failure and reconnect forever.
      openedAt = 0;
      // handlers bind to `sock` (this attempt's instance), not the reassignable `ws` — a late event
      // from a superseded socket must never touch the current one's state (same guard as use-log-stream).
      let sock: WebSocket;
      // a token holding a character no subprotocol may carry throws, and an uncaught throw here would
      // take the page down with it.
      try {
        sock = new WebSocket(url, protocols);
      } catch (error) {
        term.write(`\r\n\x1b[90m[console unavailable — ${errorMessage(error) ?? 'bad token'}]\x1b[0m\r\n`);
        ask();
        return;
      }
      ws = sock;
      sock.onopen = () => {
        if (ws !== sock) return;
        everOpened = true;
        openedAt = Date.now();
        fit.fit();
        sendResize();
        term.focus();
      };
      sock.onmessage = (e) => {
        if (ws !== sock) return;
        term.write(typeof e.data === 'string' ? e.data : '');
      };
      // onerror always precedes onclose; funnel both through onclose so reconnect lives in one place.
      sock.onerror = () => sock.close();
      sock.onclose = () => {
        if (disposed || ws !== sock) return;
        // only a socket that proved stable earns a fresh budget; an accept-then-close loop keeps
        // consuming it so the give-up path below is reachable.
        if (openedAt && Date.now() - openedAt > STREAM_STABLE_MS) retries = 0;
        if (retries >= MAX_STREAM_RETRIES) {
          term.write('\r\n\x1b[90m[console disconnected — reopen to retry]\x1b[0m\r\n');
          // the lab destroys a refused upgrade, so a budget spent without one open socket is the only
          // signal the client gets that the token, not the network, was the problem.
          if (!everOpened) ask();
          return;
        }
        retries += 1;
        reconnectTimer = setTimeout(connect, Math.min(500 * 2 ** (retries - 1), 10000));
      };
    };
    connect();

    // Guard on the live socket's readyState — `ws` is reassigned across reconnects, so this closure
    // always sends on the current one.
    const onData = term.onData((data) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ i: data })));
    // Debounce, and never refit mid-selection — term.resize() clears the selection.
    let roTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(roTimer);
      roTimer = setTimeout(() => {
        if (term.hasSelection()) return;
        try {
          fit.fit();
          sendResize();
        } catch (error) {
          console.debug('terminal refit failed', error);
        }
      }, 100);
    });
    ro.observe(host);

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearTimeout(roTimer);
      onData.dispose();
      ro.disconnect();
      ws?.close();
      termRef.current = null;
      term.dispose();
    };
  }, [path, token, blocked, ask]);

  return (
    <div className="relative h-full w-full">
      <ConsoleControls getText={getText} />
      {gate.dialog && <div className="absolute inset-x-0 top-0 z-10 p-2">{gate.dialog}</div>}
      <div ref={hostRef} className="h-full w-full" />
    </div>
  );
}

/** Never opens the exclusive SOL socket, so it can't steal the live console. */
export function HistoryConsole({ node }: { node: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  const writtenBytesRef = useRef<number | null>(null);

  const [following, setFollowing] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ISearchResultChangeEvent | null>(null);
  const [termGen, setTermGen] = useState(0);

  const q = tsr.getMachineConsoleLog.useQuery({
    queryKey: ['console-log', node],
    queryData: { params: { name: node }, query: { tail_bytes: HISTORY_TAIL_BYTES } },
    refetchInterval: usePoll(following ? 1500 : false),
  });
  // On a failed poll `body` is the STALE last-good 200 — guard writes on `isError`, not just on `body`.
  const body = q.data?.status === 200 ? q.data.body : null;
  const isError = q.isError;
  const err = errorMessage(q.error);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({ ...TERM_OPTS, cursorBlink: false, disableStdin: true });
    termRef.current = term;
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    searchRef.current = search;
    term.open(host);
    fit.fit();
    writtenBytesRef.current = null;
    setTermGen((g) => g + 1);
    const sub = search.onDidChangeResults(setResults);

    let roTimer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(roTimer);
      roTimer = setTimeout(() => {
        if (term.hasSelection()) return;
        try {
          fit.fit();
        } catch (error) {
          console.debug('terminal refit failed', error);
        }
      }, 100);
    });
    ro.observe(host);

    return () => {
      clearTimeout(roTimer);
      sub.dispose();
      ro.disconnect();
      termRef.current = null;
      searchRef.current = null;
      term.dispose();
    };
  }, [node]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (isError || !body) {
      if (writtenBytesRef.current !== null) {
        term.clear();
        writtenBytesRef.current = null;
      }
      return;
    }
    const prev = writtenBytesRef.current;
    if (prev === null || body.bytes < prev) {
      term.clear();
      term.write(body.content);
    } else if (body.bytes > prev) {
      const delta = body.bytes - prev;
      if (delta >= body.content.length) {
        term.clear();
        term.write(body.content);
      } else {
        term.write(body.content.slice(body.content.length - delta));
      }
    }
    writtenBytesRef.current = body.bytes;
  }, [body, isError, termGen]);

  const runFind = (dir: 'next' | 'prev', term = query) => {
    const search = searchRef.current;
    if (!search) return;
    if (!term) {
      search.clearDecorations();
      setResults(null);
      return;
    }
    const opts = { ...SEARCH_OPTS, incremental: dir === 'next' };
    if (dir === 'next') search.findNext(term, opts);
    else search.findPrevious(term, opts);
  };

  const matchLabel =
    query && results
      ? results.resultCount === 0
        ? '0/0'
        : `${results.resultIndex >= 0 ? results.resultIndex + 1 : '?'}/${results.resultCount}`
      : '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 px-3 py-2 text-xs">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            runFind('next', e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              runFind(e.shiftKey ? 'prev' : 'next');
            }
          }}
          placeholder="find…"
          className="w-40 rounded border border-white/10 bg-transparent px-2 py-0.5 font-mono text-white/80 placeholder:text-white/25 focus:border-sky-400/50 focus:outline-none"
        />
        <button
          onClick={() => runFind('prev')}
          className="rounded border border-white/10 px-1.5 py-0.5 text-white/50 hover:bg-white/5"
          title="Previous match (Shift+Enter)"
        >
          ↑
        </button>
        <button
          onClick={() => runFind('next')}
          className="rounded border border-white/10 px-1.5 py-0.5 text-white/50 hover:bg-white/5"
          title="Next match (Enter)"
        >
          ↓
        </button>
        {matchLabel && <span className="text-white/40">{matchLabel}</span>}

        <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-white/60">
          <input type="checkbox" checked={following} onChange={(e) => setFollowing(e.target.checked)} />
          follow
        </label>
        {body && !isError && (
          <a
            href={`/api/fleet/machines/${encodeURIComponent(node)}/console-log/download`}
            download={`${node}.log`}
            className="rounded border border-white/10 px-2 py-0.5 text-white/60 hover:bg-white/5"
            title="Download the full serial-console log"
          >
            ↧ download
          </a>
        )}
      </div>

      {err && <div className="px-3 py-2 text-xs text-red-300">{err}</div>}
      {q.isPending && !body && !err && <div className="px-3 py-2 text-xs text-white/30">loading…</div>}

      <div ref={hostRef} className="min-h-0 flex-1 p-2" />

      {body && !isError && (
        <div className="border-t border-white/10 px-3 py-1 text-[11px] text-white/35">
          {fmtBytes(body.bytes)} on disk
          {body.truncated && ` · showing last ${fmtBytes(HISTORY_TAIL_BYTES)}`}
          {following && ' · following'}
        </div>
      )}
    </div>
  );
}

export function VmConsole({ node, onClose }: { node: string; onClose: () => void }) {
  const [tab, setTab] = useState<'history' | 'live'>('history');
  const [fullscreen, setFullscreen] = useState(false);

  const tabCls = (active: boolean) =>
    [
      'rounded px-2 py-0.5 text-sm transition',
      active ? 'bg-white/10 text-white/90' : 'text-white/50 hover:bg-white/5',
    ].join(' ');

  return (
    <div
      className={[
        'flex flex-col rounded-lg border border-white/15 bg-[#0b0e14]',
        fullscreen ? 'fixed inset-0 z-50' : 'absolute inset-0 z-20',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <button onClick={() => setTab('history')} className={tabCls(tab === 'history')}>
          History
        </button>
        <button onClick={() => setTab('live')} className={tabCls(tab === 'live')}>
          Live
        </button>
        <div className="ml-2 truncate font-mono text-sm text-white/80">
          {node}
          {tab === 'live' && <span className="ml-2 text-white/30">(detach VM-side with Ctrl-])</span>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setFullscreen((f) => !f)}
            className="px-2 text-sm text-white/50 hover:text-white"
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen ? '⤡ shrink' : '⤢ expand'}
          </button>
          <button onClick={onClose} className="px-2 text-sm text-white/50 hover:text-white">
            ✕ close
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'history' ? (
          <HistoryConsole node={node} />
        ) : (
          <div className="h-full p-2">
            <Xterm path={streamPaths.fleetShell(node)} />
          </div>
        )}
      </div>
    </div>
  );
}
