// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_STREAM_RETRIES, STREAM_STABLE_MS } from './reconnect';
import { useLogStream } from './use-log-stream';

class MockEventSource {
  static instances: MockEventSource[] = [];
  url: string;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emitOpen() {
    this.onopen?.();
  }

  emitLine(line: string) {
    this.onmessage?.({ data: JSON.stringify({ line }) });
  }

  emitDone() {
    this.onmessage?.({ data: JSON.stringify({ done: true }) });
  }

  emitError() {
    this.onerror?.();
  }
}

const instances = () => MockEventSource.instances;
const latest = () => MockEventSource.instances[MockEventSource.instances.length - 1];

describe('useLogStream reconnect state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('does not retry a finite stream that closed after the done sentinel', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/runs/r1/stream'));
    expect(instances()).toHaveLength(1);
    act(() => {
      latest().emitOpen();
      latest().emitLine('backlog 1');
      latest().emitLine('backlog 2');
      latest().emitDone();
      latest().emitError();
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(instances()).toHaveLength(1);
    expect(result.current.degraded).toBe(false);
    expect(result.current.disconnected).toBe(false);
  });

  it('keeps retrying a chatty finite stream that drops repeatedly without the sentinel', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/runs/r1/stream'));
    act(() => {
      latest().emitOpen();
      latest().emitLine('live 1');
      latest().emitError();
    });
    act(() => vi.advanceTimersByTime(500));
    expect(instances()).toHaveLength(2);
    act(() => {
      latest().emitOpen();
      latest().emitLine('live 1');
      latest().emitLine('live 2');
      latest().emitError();
    });
    act(() => vi.advanceTimersByTime(1_000));
    expect(instances()).toHaveLength(3);
    expect(result.current.disconnected).toBe(false);
  });

  it('retries an infinite tail with exponential backoff and flags degraded after a failed retry', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/stack/services/hub/log', { finite: false }));
    act(() => {
      latest().emitOpen();
      latest().emitError();
    });
    act(() => vi.advanceTimersByTime(499));
    expect(instances()).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(instances()).toHaveLength(2);
    expect(result.current.degraded).toBe(false);
    act(() => latest().emitError());
    expect(result.current.degraded).toBe(true);
    act(() => vi.advanceTimersByTime(999));
    expect(instances()).toHaveLength(2);
    act(() => vi.advanceTimersByTime(1));
    expect(instances()).toHaveLength(3);
  });

  it('stops at the retry budget and reports a terminal disconnect', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/stack/services/hub/log', { finite: false }));
    for (let i = 0; i < MAX_STREAM_RETRIES; i++) {
      act(() => latest().emitError());
      act(() => vi.advanceTimersByTime(20_000));
    }
    expect(instances()).toHaveLength(1 + MAX_STREAM_RETRIES);
    act(() => latest().emitError());
    act(() => vi.advanceTimersByTime(60_000));
    expect(instances()).toHaveLength(1 + MAX_STREAM_RETRIES);
    expect(result.current.disconnected).toBe(true);
    expect(result.current.degraded).toBe(false);
  });

  it('goes terminal when a finite stream repeatedly closes fast without the sentinel (version skew)', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/runs/r1/stream'));
    for (let i = 0; i <= MAX_STREAM_RETRIES; i++) {
      act(() => {
        latest().emitOpen();
        latest().emitLine('backlog');
        latest().emitError();
      });
      act(() => vi.advanceTimersByTime(20_000));
    }
    expect(instances()).toHaveLength(1 + MAX_STREAM_RETRIES);
    expect(result.current.disconnected).toBe(true);
  });

  it('does not report disconnected when the run completes on the last budgeted reconnect', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/runs/r1/stream'));
    for (let i = 0; i < MAX_STREAM_RETRIES; i++) {
      act(() => latest().emitError());
      act(() => vi.advanceTimersByTime(20_000));
    }
    act(() => {
      latest().emitOpen();
      latest().emitLine('backlog');
      latest().emitDone();
      latest().emitError();
    });
    expect(result.current.disconnected).toBe(false);
    expect(result.current.degraded).toBe(false);
  });

  it('refreshes the retry budget after a connection stayed stable', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/stack/services/hub/log', { finite: false }));
    for (let i = 0; i < MAX_STREAM_RETRIES; i++) {
      act(() => latest().emitError());
      act(() => vi.advanceTimersByTime(20_000));
    }
    act(() => latest().emitOpen());
    act(() => vi.advanceTimersByTime(STREAM_STABLE_MS + 1));
    act(() => latest().emitError());
    act(() => vi.advanceTimersByTime(20_000));
    expect(instances()).toHaveLength(2 + MAX_STREAM_RETRIES);
    expect(result.current.disconnected).toBe(false);
  });

  it('ignores events from a superseded EventSource', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/runs/r1/stream'));
    const stale = latest();
    act(() => result.current.open('/api/runs/r2/stream', { finite: false }));
    expect(stale.closed).toBe(true);
    act(() => {
      stale.emitOpen();
      stale.emitError();
    });
    act(() => vi.advanceTimersByTime(60_000));
    expect(instances()).toHaveLength(2);
    expect(result.current.degraded).toBe(false);
    expect(result.current.disconnected).toBe(false);
  });

  it('retries a finite drop without the sentinel and keeps the buffer until a reconnect opens', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/runs/r1/stream'));
    act(() => {
      latest().emitOpen();
      latest().emitLine('live line');
    });
    expect(result.current.logHtml).toContain('live line');
    expect(result.current.logText).toContain('live line');
    act(() => latest().emitError());
    expect(result.current.logHtml).toContain('live line');
    act(() => vi.advanceTimersByTime(500));
    expect(instances()).toHaveLength(2);
    act(() => latest().emitOpen());
    expect(result.current.logHtml).toBe('');
    expect(result.current.logText).toBe('');
  });

  it('close() clears the degraded/disconnected flags of a dead stream', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/stack/services/hub/log', { finite: false }));
    for (let i = 0; i <= MAX_STREAM_RETRIES; i++) {
      act(() => latest().emitError());
      act(() => vi.advanceTimersByTime(20_000));
    }
    expect(result.current.disconnected).toBe(true);
    act(() => result.current.close());
    expect(result.current.disconnected).toBe(false);
    expect(result.current.degraded).toBe(false);
  });

  it('open() cancels a pending reconnect timer', () => {
    const { result } = renderHook(() => useLogStream());
    act(() => result.current.open('/api/stack/services/hub/log', { finite: false }));
    act(() => latest().emitError());
    act(() => result.current.open('/api/runs/r9/stream'));
    expect(instances()).toHaveLength(2);
    act(() => vi.advanceTimersByTime(60_000));
    expect(instances()).toHaveLength(2);
  });
});
