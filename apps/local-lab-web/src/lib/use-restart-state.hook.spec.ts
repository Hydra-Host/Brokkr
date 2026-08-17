// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestartState } from '@/contract';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('@/lib/api', () => ({ tsr: { getRestartState: { useQuery: mocks.useQuery } } }));

import {
  markRecreating,
  peekRecreating,
  RECREATE_FLAG_KEY,
  RESTART_POLL_INTERVAL_MS,
  useApiHealth,
} from './use-restart-state';

const answer = (body: RestartState | null, isError = false) =>
  mocks.useQuery.mockReturnValue({ data: body === null ? undefined : { status: 200, body }, isError });

describe('useApiHealth', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.useQuery.mockReset();
    answer(null);
  });

  afterEach(cleanup);

  it('polls the marker on the stack cadence and never retries a dead api', () => {
    renderHook(() => useApiHealth());

    expect(mocks.useQuery).toHaveBeenLastCalledWith({
      queryKey: ['restart-state'],
      refetchInterval: RESTART_POLL_INTERVAL_MS,
      retry: false,
    });
  });

  it('shows the recreation from a launch stamp while the api is unreachable', () => {
    markRecreating('reinit');
    answer(null, true);

    const { result } = renderHook(() => useApiHealth());

    expect(result.current.banner?.variant).toBe('pending');
    expect(result.current.link).toBe('offline');
  });

  it('shows a stamp written after mount when the failing poll is the first one to see it', () => {
    answer({ status: 'idle' });
    const { result, rerender } = renderHook(() => useApiHealth());
    expect(result.current.banner).toBeNull();

    markRecreating('reinit');
    answer(null, true);
    rerender();

    expect(result.current.banner?.variant).toBe('pending');
    expect(result.current.link).toBe('offline');
  });

  it('drops the launch stamp once the server stops calling the restart in flight', () => {
    markRecreating('reinit');
    answer({ status: 'idle' });

    const { result } = renderHook(() => useApiHealth());

    expect(peekRecreating()).toBeNull();
    expect(result.current.banner).toBeNull();
    expect(result.current.link).toBe('online');
  });

  it('drops the launch stamp on a failure, which the marker now reports on its own', () => {
    markRecreating('reinit');
    answer({ status: 'failed', logPath: '/state/lab-restart.log' });

    const { result } = renderHook(() => useApiHealth());

    expect(peekRecreating()).toBeNull();
    expect(result.current.banner?.variant).toBe('failed');
  });

  it('keeps the launch stamp while the server still reports the restart in flight', () => {
    markRecreating('reinit');
    answer({ status: 'pending' });

    renderHook(() => useApiHealth());

    expect(peekRecreating()?.opId).toBe('reinit');
  });

  it('keeps the stamp untouched while the api is unreachable', () => {
    markRecreating('purge');
    answer({ status: 'idle' }, true);

    renderHook(() => useApiHealth());

    expect(peekRecreating()?.opId).toBe('purge');
  });

  it('ignores a stamp left by an older incompatible build', () => {
    sessionStorage.setItem(RECREATE_FLAG_KEY, 'reinit');
    answer(null, true);

    const { result } = renderHook(() => useApiHealth());

    expect(peekRecreating()).toBeNull();
    expect(result.current.banner?.variant).toBe('unreachable');
  });

  it('banners a bare api outage when no recreation explains it', () => {
    answer(null, true);

    const { result } = renderHook(() => useApiHealth());

    expect(result.current.banner?.variant).toBe('unreachable');
    expect(result.current.link).toBe('offline');
  });
});
