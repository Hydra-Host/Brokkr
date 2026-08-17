// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sudoQuery: vi.fn(),
  sudoRefetch: vi.fn(),
  startMutate: vi.fn(),
  cacheSudoAsync: vi.fn(),
  confirmApply: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  tsr: {
    startStackRun: { useMutation: () => ({ mutate: mocks.startMutate, isPending: false }) },
    getSudoStatus: { useQuery: mocks.sudoQuery },
    cacheSudo: { useMutation: () => ({ mutateAsync: mocks.cacheSudoAsync, isPending: false }) },
  },
}));
vi.mock('@/lib/use-apply-confirm', () => ({ useApplyConfirm: () => ({ confirmApply: mocks.confirmApply }) }));

import { useApplyPending } from './apply-run';

const applyModeChange = async (onError: (msg: string) => void) => {
  const { result } = renderHook(() => useApplyPending(vi.fn(), onError));
  await result.current.apply(true);
};

describe('useApplyPending sudo gate', () => {
  beforeEach(() => {
    mocks.sudoQuery.mockReset();
    mocks.sudoRefetch.mockReset();
    mocks.startMutate.mockReset();
    mocks.cacheSudoAsync.mockReset();
    mocks.confirmApply.mockReset();
    mocks.sudoRefetch.mockResolvedValue({ data: { status: 200, body: { available: false } } });
    mocks.sudoQuery.mockReturnValue({
      data: { status: 200, body: { available: false } },
      refetch: mocks.sudoRefetch,
    });
    vi.stubGlobal('prompt', vi.fn().mockReturnValue('hunter2'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it('surfaces the throttle message and its retry hint instead of blaming the password', async () => {
    mocks.cacheSudoAsync.mockRejectedValue({
      status: 429,
      body: { error: 'too many rejected sudo attempts; retry in 30s' },
    });
    const onError = vi.fn();

    await applyModeChange(onError);

    expect(onError).toHaveBeenCalledWith('too many rejected sudo attempts; retry in 30s');
    expect(onError).not.toHaveBeenCalledWith('sudo password rejected');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('surfaces the in-flight throttle refusal', async () => {
    mocks.cacheSudoAsync.mockRejectedValue({ status: 429, body: { error: 'a sudo attempt is already in flight' } });
    const onError = vi.fn();

    await applyModeChange(onError);

    expect(onError).toHaveBeenCalledWith('a sudo attempt is already in flight');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('still reports a rejected password from the 401 body', async () => {
    mocks.cacheSudoAsync.mockRejectedValue({ status: 401, body: { error: 'sudo password rejected' } });
    const onError = vi.fn();

    await applyModeChange(onError);

    expect(onError).toHaveBeenCalledWith('sudo password rejected');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('falls back to the generic message for a failure carrying no server message', async () => {
    mocks.cacheSudoAsync.mockRejectedValue({ status: 500, body: {} });
    const onError = vi.fn();

    await applyModeChange(onError);

    expect(onError).toHaveBeenCalledWith('sudo password rejected');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('falls back to the generic message when the request never reached the lab', async () => {
    mocks.cacheSudoAsync.mockRejectedValue(new Error('network down'));
    const onError = vi.fn();

    await applyModeChange(onError);

    expect(onError).toHaveBeenCalledWith('sudo password rejected');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('starts the mode-change run once the credential is cached', async () => {
    mocks.cacheSudoAsync.mockResolvedValue({ status: 200, body: { ok: true } });
    const onError = vi.fn();

    await applyModeChange(onError);

    expect(onError).not.toHaveBeenCalled();
    expect(mocks.startMutate).toHaveBeenCalledWith({ body: { opId: 'fleet-mode-apply' } }, expect.anything());
  });

  it('skips the prompt entirely when sudo is already cached', async () => {
    mocks.sudoRefetch.mockResolvedValue({ data: { status: 200, body: { available: true } } });
    const onError = vi.fn();

    await applyModeChange(onError);

    expect(mocks.cacheSudoAsync).not.toHaveBeenCalled();
    expect(mocks.startMutate).toHaveBeenCalledWith({ body: { opId: 'fleet-mode-apply' } }, expect.anything());
  });
});
