// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRangeAnchor } from './use-range-anchor';

const ADVANCE_MS = 30_000;

function renderTracked(metric: string | null) {
  const seen: Array<{ metric: string | null; anchored: string | null }> = [];
  const view = renderHook(
    ({ m }: { m: string | null }) => {
      const anchor = useRangeAnchor(m, ADVANCE_MS);
      seen.push({ metric: m, anchored: anchor?.metric ?? null });
      return anchor;
    },
    { initialProps: { m: metric } },
  );
  return { ...view, seen };
}

describe('useRangeAnchor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('yields no anchor without a metric', () => {
    const { result } = renderTracked(null);
    expect(result.current).toBeNull();
  });

  it('anchors on the selected metric at wall-clock', () => {
    const { result } = renderTracked('up');
    expect(result.current).toEqual({ metric: 'up', nowMs: Date.parse('2026-01-01T00:00:00Z') });
  });

  it('never yields an anchor belonging to a different metric than the render asked for', () => {
    const { rerender, seen } = renderTracked('up');
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
    rerender({ m: 'go_goroutines' });

    expect(seen.length).toBeGreaterThan(2);
    for (const frame of seen) {
      if (frame.anchored !== null) expect(frame.anchored).toBe(frame.metric);
    }
  });

  it('re-anchors to wall-clock when the metric changes', () => {
    const { result, rerender } = renderTracked('up');
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'));
    rerender({ m: 'go_goroutines' });

    expect(result.current).toEqual({ metric: 'go_goroutines', nowMs: Date.parse('2026-01-01T00:05:00Z') });
  });

  it('advances the anchor on the interval', () => {
    const { result } = renderTracked('up');
    const first = result.current?.nowMs ?? 0;

    act(() => {
      vi.advanceTimersByTime(ADVANCE_MS);
    });
    expect(result.current?.nowMs).toBe(first + ADVANCE_MS);

    act(() => {
      vi.advanceTimersByTime(ADVANCE_MS);
    });
    expect(result.current?.nowMs).toBe(first + ADVANCE_MS * 2);
    expect(result.current?.metric).toBe('up');
  });

  it('stops advancing after unmount', () => {
    const { result, unmount, seen } = renderTracked('up');
    const last = result.current?.nowMs;
    const renders = seen.length;
    unmount();

    act(() => {
      vi.advanceTimersByTime(ADVANCE_MS * 3);
    });

    expect(seen.length).toBe(renders);
    expect(result.current?.nowMs).toBe(last);
  });
});
