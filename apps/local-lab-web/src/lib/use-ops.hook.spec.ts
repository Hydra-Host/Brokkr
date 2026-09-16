// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StackOp } from '@/contract';

const mocks = vi.hoisted(() => ({
  opsQuery: vi.fn(),
  runsQuery: vi.fn(),
  sudoQuery: vi.fn(),
  startMutate: vi.fn(),
  cancelMutate: vi.fn(),
  cacheSudoMutate: vi.fn(),
  refetch: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock('@/lib/use-apply-confirm', () => ({ useApplyPrompt: () => mocks.prompt }));
vi.mock('@/lib/api', () => ({
  tsr: {
    listStackOps: { useQuery: mocks.opsQuery },
    listRuns: { useQuery: mocks.runsQuery },
    getSudoStatus: { useQuery: mocks.sudoQuery },
    startStackRun: { useMutation: () => ({ mutate: mocks.startMutate, isPending: false }) },
    cancelRun: { useMutation: () => ({ mutate: mocks.cancelMutate, isPending: false }) },
    cacheSudo: { useMutation: () => ({ mutate: mocks.cacheSudoMutate, isPending: false }) },
  },
}));

import { errText } from '@/features/datastore/shared/error-banner';

import { OPS_POLL_MS, useOps } from './use-ops';
import { peekRecreating } from './use-restart-state';

type SudoHandlers = {
  onSuccess: (res: { status: number; body: unknown }) => void;
  onError: (err: unknown) => void;
};

const plainOp: StackOp = {
  id: 'reconcile',
  label: 'Reconcile',
  task: 'stack-reconcile',
  description: 'self-heals the control plane',
  section: 'stack',
  group: 'bringup',
  destructive: false,
  needsSudo: false,
};

const reinitOp: StackOp = {
  id: 'reinit',
  label: 'Reinit (nuke + rebuild)',
  task: 'stack-down && stack-wipe-data; stack-up',
  description: 'wipes the datastores then brings the whole stack back up',
  section: 'stack',
  group: 'destructive',
  destructive: true,
  needsSudo: true,
};

const sudoOp: StackOp = {
  id: 'fleet-up',
  label: 'Bring the fleet up',
  task: 'sim:up',
  description: 'boots the simulated fleet',
  section: 'stack',
  group: 'bringup',
  destructive: false,
  needsSudo: true,
};

const lastSudoHandlers = (): SudoHandlers => {
  const call = mocks.cacheSudoMutate.mock.calls.at(-1);
  if (!call) throw new Error('cacheSudo.mutate was not called');
  return call[1];
};

const openSudoGate = () => {
  const view = renderHook(() => useOps('stack', vi.fn(), vi.fn()));
  act(() => view.result.current.onOpClick(sudoOp));
  view.rerender();
  act(() => view.result.current.gate?.confirm());
  return view;
};

const lastStartHandlers = (): SudoHandlers => {
  const call = mocks.startMutate.mock.calls.at(-1);
  if (!call) throw new Error('startStackRun.mutate was not called');
  return call[1];
};

const launchPlainOp = (onError = vi.fn()) => {
  const view = renderHook(() => useOps('stack', vi.fn(), onError));
  act(() => view.result.current.onOpClick(plainOp));
  view.rerender();
  return { view, onError };
};

const launchThroughSudoGate = (op: StackOp) => {
  const view = renderHook(() => useOps('stack', vi.fn(), vi.fn()));
  act(() => view.result.current.onOpClick(op));
  view.rerender();
  act(() => view.result.current.gate?.confirm());
  act(() => lastSudoHandlers().onSuccess({ status: 200, body: { ok: true } }));
  view.rerender();
  return view;
};

describe('useOps sudo gate', () => {
  beforeEach(() => {
    mocks.opsQuery.mockReset();
    mocks.runsQuery.mockReset();
    mocks.sudoQuery.mockReset();
    mocks.startMutate.mockReset();
    mocks.cancelMutate.mockReset();
    mocks.cacheSudoMutate.mockReset();
    mocks.refetch.mockReset();
    mocks.prompt.mockReset();
    mocks.opsQuery.mockReturnValue({
      data: { status: 200, body: [sudoOp, plainOp, reinitOp] },
      refetch: mocks.refetch,
    });
    mocks.runsQuery.mockReturnValue({ data: { status: 200, body: [] }, refetch: mocks.refetch });
    mocks.sudoQuery.mockReturnValue({ data: { status: 200, body: { available: false } }, refetch: mocks.refetch });
  });

  afterEach(cleanup);

  it('surfaces the throttle message and its retry hint when the cooldown refuses the attempt', () => {
    const view = openSudoGate();

    act(() =>
      lastSudoHandlers().onError({
        status: 429,
        body: { error: 'too many rejected sudo attempts; retry in 30s' },
      }),
    );
    view.rerender();

    expect(view.result.current.gate?.error).toBe('too many rejected sudo attempts; retry in 30s');
    expect(view.result.current.gate?.error).toContain('retry in 30s');
    expect(view.result.current.gate?.error).not.toContain('sudo password rejected');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('surfaces the in-flight throttle refusal rather than blaming the password', () => {
    const view = openSudoGate();

    act(() => lastSudoHandlers().onError({ status: 429, body: { error: 'a sudo attempt is already in flight' } }));
    view.rerender();

    expect(view.result.current.gate?.error).toBe('a sudo attempt is already in flight');
    expect(view.result.current.gate?.error).not.toContain('sudo password rejected');
  });

  it('still reports a rejected password from the 401 body', () => {
    const view = openSudoGate();

    act(() => lastSudoHandlers().onError({ status: 401, body: { error: 'sudo password rejected' } }));
    view.rerender();

    expect(view.result.current.gate?.error).toBe('sudo password rejected');
  });

  it('falls back to the generic message for a failure carrying no server message', () => {
    const view = openSudoGate();

    act(() => lastSudoHandlers().onError({ status: 500, body: {} }));
    view.rerender();

    expect(view.result.current.gate?.error).toBe('failed to validate sudo');
  });

  it('falls back to the generic message when the request never reached the lab', () => {
    const view = openSudoGate();

    act(() => lastSudoHandlers().onError(new Error('network down')));
    view.rerender();

    expect(view.result.current.gate?.error).toBe('failed to validate sudo');
  });

  it('launches the op and clears the gate once the credential is cached', () => {
    const view = openSudoGate();

    act(() => lastSudoHandlers().onSuccess({ status: 200, body: { ok: true } }));
    view.rerender();

    expect(mocks.startMutate).toHaveBeenCalledWith(
      { body: { opId: 'fleet-up', allowDataLoss: false, force: false } },
      expect.anything(),
    );
    expect(view.result.current.gate).toBeNull();
  });
});

describe('useOps launch failures', () => {
  beforeEach(() => {
    sessionStorage.clear();
    mocks.opsQuery.mockReset();
    mocks.runsQuery.mockReset();
    mocks.sudoQuery.mockReset();
    mocks.startMutate.mockReset();
    mocks.cancelMutate.mockReset();
    mocks.cacheSudoMutate.mockReset();
    mocks.refetch.mockReset();
    mocks.prompt.mockReset();
    mocks.opsQuery.mockReturnValue({
      data: { status: 200, body: [sudoOp, plainOp, reinitOp] },
      refetch: mocks.refetch,
    });
    mocks.runsQuery.mockReturnValue({ data: { status: 200, body: [] }, refetch: mocks.refetch });
    mocks.sudoQuery.mockReturnValue({ data: { status: 200, body: { available: false } }, refetch: mocks.refetch });
  });

  afterEach(cleanup);

  it('reports the busy-lane refusal the server rejected the launch with', () => {
    const { view, onError } = launchPlainOp();

    act(() => lastStartHandlers().onError({ status: 409, body: { error: 'a stack op is already running' } }));
    view.rerender();

    expect(onError).toHaveBeenCalledWith('a stack op is already running');
  });

  it('drops the ring highlight off the op the server refused', () => {
    const { view } = launchPlainOp();
    expect(view.result.current.activeOp).toBe('reconcile');

    act(() => lastStartHandlers().onError({ status: 409, body: { error: 'a stack op is already running' } }));
    view.rerender();

    expect(view.result.current.activeOp).toBeNull();
  });

  it('falls back to a generic message when the refusal carries none', () => {
    const { view, onError } = launchPlainOp();

    act(() => lastStartHandlers().onError(new Error('network down')));
    view.rerender();

    expect(onError).toHaveBeenCalledWith('start failed');
  });

  it('honours an empty server message as deliberate toast suppression, and still frees the op', () => {
    const { view, onError } = launchPlainOp();

    act(() => lastStartHandlers().onError({ status: 409, body: { error: '' } }));
    view.rerender();

    expect(onError).not.toHaveBeenCalled();
    expect(view.result.current.activeOp).toBeNull();
  });

  it('stamps the session before a recreation op can take the api down', () => {
    launchThroughSudoGate(reinitOp);

    expect(mocks.startMutate).toHaveBeenCalledWith(
      { body: { opId: 'reinit', allowDataLoss: false, force: false } },
      expect.anything(),
    );
    expect(peekRecreating()?.opId).toBe('reinit');
  });

  it('prompts to force the flip when a 409 names in-flight saga jobs, and relaunches with force on confirm', async () => {
    mocks.prompt.mockResolvedValue(true);
    const { onError } = launchPlainOp();

    await act(async () => lastStartHandlers().onError({ status: 409, body: { error: 'blocked', activeJobs: 2 } }));

    expect(onError).not.toHaveBeenCalled();
    expect(mocks.prompt).toHaveBeenCalledWith(expect.stringContaining('2 saga jobs'));
    expect(mocks.startMutate).toHaveBeenLastCalledWith(
      { body: { opId: 'reconcile', allowDataLoss: false, force: true } },
      expect.anything(),
    );
  });

  it('sends nothing when the force prompt is declined', async () => {
    mocks.prompt.mockResolvedValue(false);
    const { onError } = launchPlainOp();

    await act(async () => lastStartHandlers().onError({ status: 409, body: { error: 'blocked', activeJobs: 1 } }));

    expect(onError).not.toHaveBeenCalled();
    expect(mocks.startMutate).toHaveBeenCalledTimes(1);
  });

  it('reports a 409 without activeJobs as an error and never prompts', () => {
    const { onError } = launchPlainOp();

    act(() => lastStartHandlers().onError({ status: 409, body: { error: 'a stack op is already running' } }));

    expect(mocks.prompt).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('a stack op is already running');
  });

  it('withdraws the stamp when the recreation was refused before it started', () => {
    const view = launchThroughSudoGate(reinitOp);

    act(() => lastStartHandlers().onError({ status: 409, body: { error: 'a fleet op is already running' } }));
    view.rerender();

    expect(peekRecreating()).toBeNull();
  });

  it('leaves no stamp behind for an op that never takes the api down', () => {
    launchPlainOp();

    expect(peekRecreating()).toBeNull();
  });
});

describe('useOps registry recovery', () => {
  beforeEach(() => {
    mocks.opsQuery.mockReset();
    mocks.runsQuery.mockReset();
    mocks.sudoQuery.mockReset();
    mocks.runsQuery.mockReturnValue({ data: { status: 200, body: [] }, refetch: mocks.refetch });
    mocks.sudoQuery.mockReturnValue({ data: { status: 200, body: { available: true } }, refetch: mocks.refetch });
  });

  afterEach(cleanup);

  it('polls the op registry so a failed fetch recovers without a remount', () => {
    mocks.opsQuery.mockReturnValue({ data: { status: 200, body: [plainOp] }, refetch: mocks.refetch });

    renderHook(() => useOps('stack', vi.fn(), vi.fn()));

    expect(mocks.opsQuery).toHaveBeenCalledWith(expect.objectContaining({ refetchInterval: OPS_POLL_MS }));
    expect(OPS_POLL_MS).toBeGreaterThan(0);
  });

  it('hands the caller the failure that left the registry empty', () => {
    mocks.opsQuery.mockReturnValue({ data: undefined, error: new Error('Failed to fetch'), refetch: mocks.refetch });

    const view = renderHook(() => useOps('stack', vi.fn(), vi.fn()));

    expect(view.result.current.allOps).toEqual([]);
    expect(errText(view.result.current.opsData, view.result.current.opsError)).toBe('Failed to fetch');
  });

  it('reports no failure for a registry that answered with an empty list', () => {
    mocks.opsQuery.mockReturnValue({ data: { status: 200, body: [] }, error: null, refetch: mocks.refetch });

    const view = renderHook(() => useOps('stack', vi.fn(), vi.fn()));

    expect(view.result.current.allOps).toEqual([]);
    expect(errText(view.result.current.opsData, view.result.current.opsError)).toBeNull();
  });

  it('surfaces a non-200 registry response as the failure text', () => {
    mocks.opsQuery.mockReturnValue({
      data: { status: 500, body: { error: 'process-compose socket is gone' } },
      refetch: mocks.refetch,
    });

    const view = renderHook(() => useOps('stack', vi.fn(), vi.fn()));

    expect(errText(view.result.current.opsData, view.result.current.opsError)).toBe('process-compose socket is gone');
  });
});
