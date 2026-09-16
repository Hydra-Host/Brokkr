// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sudoQuery: vi.fn(),
  sudoRefetch: vi.fn(),
  startMutate: vi.fn(),
  cacheSudoAsync: vi.fn(),
  confirmApply: vi.fn(),
  prompt: vi.fn(),
}));
vi.mock('@/lib/api', () => ({
  tsr: {
    startStackRun: { useMutation: () => ({ mutate: mocks.startMutate, isPending: false }) },
    getSudoStatus: { useQuery: mocks.sudoQuery },
    cacheSudo: { useMutation: () => ({ mutateAsync: mocks.cacheSudoAsync, isPending: false }) },
  },
}));
vi.mock('@/lib/use-apply-confirm', () => ({
  useApplyConfirm: () => ({ confirmApply: mocks.confirmApply, prompt: mocks.prompt }),
}));

import { useApplyPending } from './apply-run';

type StartHandlers = {
  onSuccess: (res: { status: number; body: unknown }) => void;
  onError: (err: unknown) => void;
};

const applyPlanesChange = async (onError: (msg: string) => void, onRun = vi.fn()) => {
  const { result } = renderHook(() => useApplyPending(onRun, onError));
  await result.current.apply(true);
};

const rejectStartWith = (err: unknown) =>
  mocks.startMutate.mockImplementation((_body: unknown, cbs: StartHandlers) => cbs.onError(err));

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

    await applyPlanesChange(onError);

    expect(onError).toHaveBeenCalledWith('too many rejected sudo attempts; retry in 30s');
    expect(onError).not.toHaveBeenCalledWith('sudo password rejected');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('surfaces the in-flight throttle refusal', async () => {
    mocks.cacheSudoAsync.mockRejectedValue({ status: 429, body: { error: 'a sudo attempt is already in flight' } });
    const onError = vi.fn();

    await applyPlanesChange(onError);

    expect(onError).toHaveBeenCalledWith('a sudo attempt is already in flight');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('still reports a rejected password from the 401 body', async () => {
    mocks.cacheSudoAsync.mockRejectedValue({ status: 401, body: { error: 'sudo password rejected' } });
    const onError = vi.fn();

    await applyPlanesChange(onError);

    expect(onError).toHaveBeenCalledWith('sudo password rejected');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('falls back to the generic message for a failure carrying no server message', async () => {
    mocks.cacheSudoAsync.mockRejectedValue({ status: 500, body: {} });
    const onError = vi.fn();

    await applyPlanesChange(onError);

    expect(onError).toHaveBeenCalledWith('sudo password rejected');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('falls back to the generic message when the request never reached the lab', async () => {
    mocks.cacheSudoAsync.mockRejectedValue(new Error('network down'));
    const onError = vi.fn();

    await applyPlanesChange(onError);

    expect(onError).toHaveBeenCalledWith('sudo password rejected');
    expect(mocks.startMutate).not.toHaveBeenCalled();
  });

  it('starts the planes-change run once the credential is cached', async () => {
    mocks.cacheSudoAsync.mockResolvedValue({ status: 200, body: { ok: true } });
    const onError = vi.fn();

    await applyPlanesChange(onError);

    expect(onError).not.toHaveBeenCalled();
    expect(mocks.startMutate).toHaveBeenCalledWith({ body: { opId: 'fleet-planes-apply' } }, expect.anything());
  });

  it('skips the prompt entirely when sudo is already cached', async () => {
    mocks.sudoRefetch.mockResolvedValue({ data: { status: 200, body: { available: true } } });
    const onError = vi.fn();

    await applyPlanesChange(onError);

    expect(mocks.cacheSudoAsync).not.toHaveBeenCalled();
    expect(mocks.startMutate).toHaveBeenCalledWith({ body: { opId: 'fleet-planes-apply' } }, expect.anything());
  });
});

describe('useApplyPending force-apply prompt', () => {
  beforeEach(() => {
    mocks.sudoQuery.mockReset();
    mocks.sudoRefetch.mockReset();
    mocks.startMutate.mockReset();
    mocks.cacheSudoAsync.mockReset();
    mocks.confirmApply.mockReset();
    mocks.prompt.mockReset();
    mocks.sudoRefetch.mockResolvedValue({ data: { status: 200, body: { available: true } } });
    mocks.sudoQuery.mockReturnValue({
      data: { status: 200, body: { available: true } },
      refetch: mocks.sudoRefetch,
    });
  });

  afterEach(cleanup);

  it('opens the prompt from a 409 rejection that names in-flight saga jobs', async () => {
    rejectStartWith({ status: 409, body: { error: 'blocked', activeJobs: 1 } });
    mocks.prompt.mockResolvedValue(false);
    const onError = vi.fn();

    await applyPlanesChange(onError);

    expect(mocks.prompt).toHaveBeenCalledOnce();
    expect(mocks.prompt.mock.calls[0][0]).toContain('1 saga job still in flight');
    expect(onError).not.toHaveBeenCalled();
  });

  it('resends the same op with force once the operator confirms', async () => {
    rejectStartWith({ status: 409, body: { error: 'blocked', activeJobs: 2 } });
    mocks.prompt.mockResolvedValue(true);

    await applyPlanesChange(vi.fn());
    await vi.waitFor(() => expect(mocks.startMutate).toHaveBeenCalledTimes(2));

    expect(mocks.startMutate.mock.calls[1][0]).toEqual({ body: { opId: 'fleet-planes-apply', force: true } });
  });

  it('sends nothing more when the operator declines', async () => {
    rejectStartWith({ status: 409, body: { error: 'blocked', activeJobs: 2 } });
    mocks.prompt.mockResolvedValue(false);

    await applyPlanesChange(vi.fn());
    await vi.waitFor(() => expect(mocks.prompt).toHaveBeenCalledOnce());

    expect(mocks.startMutate).toHaveBeenCalledOnce();
  });

  it('renders a 409 without activeJobs as an error and never prompts', async () => {
    rejectStartWith({ status: 409, body: { error: 'busy' } });
    const onError = vi.fn();

    await applyPlanesChange(onError);

    expect(onError).toHaveBeenCalledWith('busy');
    expect(mocks.prompt).not.toHaveBeenCalled();
  });

  it('hands the run id to onRun when the launch resolves', async () => {
    mocks.startMutate.mockImplementation((_body: unknown, cbs: StartHandlers) =>
      cbs.onSuccess({ status: 200, body: { runId: 'r1' } }),
    );
    const onRun = vi.fn();

    await applyPlanesChange(vi.fn(), onRun);

    expect(onRun).toHaveBeenCalledWith('r1');
  });
});
