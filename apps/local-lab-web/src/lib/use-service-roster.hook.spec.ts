// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Service } from '@/contract';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn(), refetch: vi.fn() }));
vi.mock('@/lib/api', () => ({ tsr: { listServices: { useQuery: mocks.useQuery } } }));

import { useServiceRoster } from './use-service-roster';

const service = (id: string, group: string, state: { running: boolean; ready: boolean }): Service => ({
  id,
  label: id,
  group,
  zone: null,
  port: 3000,
  running: state.running,
  ready: state.ready,
  pid: state.running ? 1 : null,
  health: state.ready ? 'up' : 'down',
  canStop: true,
});

const setRoster = (roster: Service[]) =>
  mocks.useQuery.mockReturnValue({ data: { status: 200, body: roster }, error: null, refetch: mocks.refetch });

describe('useServiceRoster', () => {
  beforeEach(() => {
    mocks.useQuery.mockReset();
    mocks.refetch.mockReset();
    setRoster([]);
  });

  afterEach(cleanup);

  it('polls the shared services key', () => {
    renderHook(() => useServiceRoster());

    expect(mocks.useQuery).toHaveBeenLastCalledWith({ queryKey: ['services'], refetchInterval: 4000 });
  });

  it('returns the first instance of a group as its representative state', () => {
    setRoster([
      service('spoke-0', 'spoke', { running: true, ready: true }),
      service('hub-api-0', 'hub', { running: true, ready: false }),
      service('hub-api-1', 'hub', { running: true, ready: true }),
    ]);
    const { result } = renderHook(() => useServiceRoster());

    expect(result.current.svcState('hub')?.id).toBe('hub-api-0');
    expect(result.current.svcState('spoke')?.id).toBe('spoke-0');
  });

  it('returns no state for a group with no live instances', () => {
    setRoster([service('hub-api-0', 'hub', { running: true, ready: true })]);
    const { result } = renderHook(() => useServiceRoster());

    expect(result.current.svcState('spoke')).toBeUndefined();
  });

  it('counts total, ready, and running instances per group', () => {
    setRoster([
      service('hub-api-0', 'hub', { running: true, ready: true }),
      service('hub-api-1', 'hub', { running: true, ready: false }),
      service('hub-api-2', 'hub', { running: false, ready: false }),
      service('spoke-0', 'spoke', { running: true, ready: true }),
      service('lab', 'control', { running: true, ready: true }),
    ]);
    const { result } = renderHook(() => useServiceRoster());

    expect(result.current.kindStats('hub')).toEqual({ total: 3, ready: 1, running: 2 });
    expect(result.current.kindStats('spoke')).toEqual({ total: 1, ready: 1, running: 1 });
  });

  it('treats an empty roster as zero instances', () => {
    const { result } = renderHook(() => useServiceRoster());

    expect(result.current.kindStats('hub')).toEqual({ total: 0, ready: 0, running: 0 });
    expect(result.current.error).toBeNull();
  });

  it('reports a roster query failure', () => {
    mocks.useQuery.mockReturnValue({ data: undefined, error: new Error('lab api down'), refetch: mocks.refetch });
    const { result } = renderHook(() => useServiceRoster());

    expect(result.current.error).toBe('lab api down');
    expect(result.current.kindStats('hub')).toEqual({ total: 0, ready: 0, running: 0 });
  });
});
