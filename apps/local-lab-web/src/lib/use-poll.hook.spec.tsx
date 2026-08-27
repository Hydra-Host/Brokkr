// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('@/lib/api', () => ({ tsr: { listServices: { useQuery: mocks.useQuery } } }));

import { ApiDownProvider, apiIsDown, pollInterval, usePoll } from './use-poll';
import { useServiceRoster } from './use-service-roster';

const wrap = (apiDown: boolean) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <ApiDownProvider value={apiDown}>{children}</ApiDownProvider>;
  };

describe('apiIsDown', () => {
  it('is false with no banner', () => {
    expect(apiIsDown(null)).toBe(false);
  });

  it('is true for every variant that means the API is not answering', () => {
    expect(apiIsDown({ variant: 'pending' })).toBe(true);
    expect(apiIsDown({ variant: 'stale' })).toBe(true);
    expect(apiIsDown({ variant: 'unreachable' })).toBe(true);
  });

  it('is false for a failed recreation — the marker was read back over HTTP', () => {
    expect(apiIsDown({ variant: 'failed' })).toBe(false);
  });
});

describe('pollInterval', () => {
  it('keeps the interval while the API answers', () => {
    expect(pollInterval(3000, false)).toBe(3000);
    expect(pollInterval(false, false)).toBe(false);
  });

  it('drops the interval during a known outage', () => {
    expect(pollInterval(3000, true)).toBe(false);
    expect(pollInterval(1500, true)).toBe(false);
  });
});

describe('usePoll', () => {
  afterEach(cleanup);

  it('defaults to polling with no provider above it', () => {
    expect(renderHook(() => usePoll(3000)).result.current).toBe(3000);
  });

  it('yields the interval when the API answers and false when it does not', () => {
    expect(renderHook(() => usePoll(3000), { wrapper: wrap(false) }).result.current).toBe(3000);
    expect(renderHook(() => usePoll(3000), { wrapper: wrap(true) }).result.current).toBe(false);
  });
});

describe('a gated consumer', () => {
  beforeEach(() => {
    mocks.useQuery.mockReset();
    mocks.useQuery.mockReturnValue({ data: undefined, error: null, refetch: vi.fn() });
  });

  afterEach(cleanup);

  it('polls /api/services on its own cadence while the API answers', () => {
    renderHook(() => useServiceRoster(), { wrapper: wrap(false) });
    expect(mocks.useQuery).toHaveBeenLastCalledWith({ queryKey: ['services'], refetchInterval: 4000 });
  });

  it('stops polling /api/services during an outage the app started itself', () => {
    renderHook(() => useServiceRoster(), { wrapper: wrap(true) });
    expect(mocks.useQuery).toHaveBeenLastCalledWith({ queryKey: ['services'], refetchInterval: false });
  });
});
