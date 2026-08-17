// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { streamPaths } from '@/contract';

import { awaitFleetRun, useLogStream } from './use-log-stream';

class MockEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  url: string;
  readyState = MockEventSource.CONNECTING;
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
    this.readyState = MockEventSource.CLOSED;
  }

  emitDone() {
    this.onmessage?.({ data: JSON.stringify({ done: true }) });
  }

  emitTransientError() {
    this.readyState = MockEventSource.CONNECTING;
    this.onerror?.();
  }

  emitFatalError() {
    this.readyState = MockEventSource.CLOSED;
    this.onerror?.();
  }
}

const instances = () => MockEventSource.instances;

describe('awaitFleetRun', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('refreshes verify after the heal run completes even when the shared pane switched streams [bugbot cbf226b4-f928-46f8-a7ea-337ae6472511]', async () => {
    const { result } = renderHook(() => useLogStream());
    const refreshed = vi.fn();

    act(() => result.current.open(streamPaths.run('heal-1')));
    const watch = awaitFleetRun('heal-1');
    void watch.then(refreshed);
    const watcherEs = instances()[1];
    expect(watcherEs.url).toContain('/api/runs/heal-1/stream');

    act(() => result.current.open('/api/stack/services/hub/log', { finite: false }));
    expect(refreshed).not.toHaveBeenCalled();

    watcherEs.emitDone();
    await watch;

    expect(refreshed).toHaveBeenCalledTimes(1);
    expect(watcherEs.closed).toBe(true);
  });

  it('settles when the run stream terminally closes without a sentinel', async () => {
    const done = vi.fn();
    const watch = awaitFleetRun('gone');
    void watch.then(done);

    instances()[0].emitTransientError();
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();

    instances()[0].emitFatalError();
    await watch;

    expect(done).toHaveBeenCalledTimes(1);
    expect(instances()[0].closed).toBe(true);
  });
});
