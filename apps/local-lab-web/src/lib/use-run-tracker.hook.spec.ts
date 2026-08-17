// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Run } from '@/contract';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('@/lib/api', () => ({ tsr: { getRun: { useQuery: mocks.useQuery } } }));

import { RUN_POLL_INTERVAL_MS, RUN_WEDGE_TIMEOUT_MS, useRunTracker } from './use-run-tracker';

const run = (runId: string, status: Run['status']): Run => ({
  runId,
  section: 'stack',
  opId: 'redeploy',
  label: 'redeploy',
  status,
  startedAt: 0,
  finishedAt: status === 'running' ? null : 1,
  exitCode: status === 'running' ? null : 0,
  nodeIndex: null,
  origin: null,
  hasLog: false,
  hasResult: false,
});

let observation = 0;
const setRun = (body: Run | null) =>
  mocks.useQuery.mockReturnValue({
    data: body === null ? undefined : { status: 200, body },
    dataUpdatedAt: ++observation,
  });

describe('useRunTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.useQuery.mockReset();
    setRun(null);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('polls the tracked run by id and only while one is tracked', () => {
    setRun(run('r1', 'running'));
    const { result, rerender } = renderHook(() => useRunTracker());

    expect(mocks.useQuery).toHaveBeenLastCalledWith({
      queryKey: ['run', null],
      queryData: { params: { runId: '' } },
      refetchInterval: RUN_POLL_INTERVAL_MS,
      enabled: false,
      retry: false,
    });

    act(() => result.current.track('r1'));
    rerender();

    expect(mocks.useQuery).toHaveBeenLastCalledWith({
      queryKey: ['run', 'r1'],
      queryData: { params: { runId: 'r1' } },
      refetchInterval: RUN_POLL_INTERVAL_MS,
      enabled: true,
      retry: false,
    });
  });

  it('stays busy while the tracked run is running', () => {
    setRun(run('r1', 'running'));
    const { result, rerender } = renderHook(() => useRunTracker());

    act(() => result.current.track('r1'));
    rerender();

    expect(result.current.active).toBe(true);
  });

  it('ignores a response that is still describing the previous run', () => {
    setRun(run('r1', 'passed'));
    const { result, rerender } = renderHook(() => useRunTracker());

    act(() => result.current.track('r2'));
    rerender();

    expect(result.current.active).toBe(true);
  });

  it('clears and notifies once when the run reaches a terminal status', () => {
    const onTerminal = vi.fn();
    setRun(run('r1', 'running'));
    const { result, rerender } = renderHook(() => useRunTracker({ onTerminal }));

    act(() => result.current.track('r1'));
    rerender();
    expect(result.current.active).toBe(true);

    act(() => setRun(run('r1', 'passed')));
    rerender();

    expect(result.current.active).toBe(false);
    expect(onTerminal).toHaveBeenCalledTimes(1);

    rerender();
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  it('treats a cancelled run as terminal', () => {
    setRun(run('r1', 'running'));
    const { result, rerender } = renderHook(() => useRunTracker());

    act(() => result.current.track('r1'));
    rerender();

    act(() => setRun(run('r1', 'cancelled')));
    rerender();

    expect(result.current.active).toBe(false);
  });

  it('force-clears a run whose record never reports terminal', () => {
    const onTerminal = vi.fn();
    setRun(null);
    const { result, rerender } = renderHook(() => useRunTracker({ onTerminal }));

    act(() => result.current.track('r1'));
    rerender();
    expect(result.current.active).toBe(true);

    act(() => vi.advanceTimersByTime(RUN_WEDGE_TIMEOUT_MS - 1));
    expect(result.current.active).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.active).toBe(false);
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it('does not extend the wedge on a re-render that brings no new poll response', () => {
    setRun(run('r1', 'running'));
    const { result, rerender } = renderHook(() => useRunTracker({ onTerminal: () => {} }));

    act(() => result.current.track('r1'));
    rerender();

    for (let i = 0; i < 6; i++) {
      act(() => vi.advanceTimersByTime(RUN_WEDGE_TIMEOUT_MS / 5));
      rerender();
    }

    expect(result.current.active).toBe(false);
  });

  it('stays busy past the wedge timeout while the run keeps reporting running', () => {
    setRun(run('r1', 'running'));
    const { result, rerender } = renderHook(() => useRunTracker());

    act(() => result.current.track('r1'));
    rerender();

    for (let i = 0; i < 4; i++) {
      act(() => vi.advanceTimersByTime(RUN_WEDGE_TIMEOUT_MS - 1));
      act(() => setRun(run('r1', 'running')));
      rerender();
      expect(result.current.active).toBe(true);
    }

    act(() => vi.advanceTimersByTime(RUN_WEDGE_TIMEOUT_MS));
    expect(result.current.active).toBe(false);
  });

  it('holds busy through a terminal status until the wedge timeout fires', () => {
    const onTerminal = vi.fn();
    setRun(run('r1', 'running'));
    const { result, rerender } = renderHook(() => useRunTracker({ holdOnTerminal: true, onTerminal }));

    act(() => result.current.track('r1'));
    rerender();

    act(() => setRun(run('r1', 'passed')));
    rerender();
    expect(result.current.active).toBe(true);
    expect(onTerminal).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(RUN_WEDGE_TIMEOUT_MS));
    expect(result.current.active).toBe(false);
  });

  it('disarms the wedge on a terminal status so a later run gets its own budget', () => {
    setRun(run('r1', 'running'));
    const { result, rerender } = renderHook(() => useRunTracker());

    act(() => result.current.track('r1'));
    rerender();
    act(() => setRun(run('r1', 'passed')));
    rerender();

    act(() => vi.advanceTimersByTime(RUN_WEDGE_TIMEOUT_MS - 10));
    act(() => {
      setRun(run('r2', 'running'));
      result.current.track('r2');
    });
    rerender();

    act(() => vi.advanceTimersByTime(20));
    expect(result.current.active).toBe(true);

    act(() => vi.advanceTimersByTime(RUN_WEDGE_TIMEOUT_MS));
    expect(result.current.active).toBe(false);
  });
});
