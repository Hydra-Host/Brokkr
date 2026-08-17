// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BranchCheckoutResult } from '@/contract';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn(), mutate: vi.fn(), refetch: vi.fn(), pending: false }));
vi.mock('@/lib/api', () => ({
  tsr: {
    getStackBranches: { useQuery: mocks.useQuery },
    putStackBranches: { useMutation: () => ({ mutate: mocks.mutate, isPending: mocks.pending }) },
  },
}));

import { useBranchCheckout } from './use-branch-checkout';

type CheckoutHandlers = {
  onSuccess: (res: { body: BranchCheckoutResult }) => void;
  onError: (err: unknown) => void;
};

const setBranch = (branch: string | null, error: string | null = null) =>
  mocks.useQuery.mockReturnValue({
    data: { status: 200, body: { branch, error } },
    error: null,
    refetch: mocks.refetch,
  });

const setQueryError = (thrown: unknown) =>
  mocks.useQuery.mockReturnValue({ data: undefined, error: thrown, refetch: mocks.refetch });

const lastHandlers = (): CheckoutHandlers => {
  const call = mocks.mutate.mock.calls.at(-1);
  if (!call) throw new Error('putStackBranches.mutate was not called');
  return call[1];
};

const render = () => renderHook(() => useBranchCheckout());

describe('useBranchCheckout', () => {
  beforeEach(() => {
    mocks.useQuery.mockReset();
    mocks.mutate.mockReset();
    mocks.refetch.mockReset();
    mocks.pending = false;
    setBranch('master');
  });

  afterEach(cleanup);

  it('shows the current branch until a draft takes precedence', () => {
    const { result, rerender } = render();
    expect(result.current.inputValue()).toBe('master');

    act(() => result.current.setInput('feature'));
    rerender();
    expect(result.current.inputValue()).toBe('feature');
  });

  it('keeps an empty draft in precedence over the current branch', () => {
    const { result, rerender } = render();

    act(() => result.current.setInput(''));
    rerender();

    expect(result.current.inputValue()).toBe('');
  });

  it('falls back to an empty input when the current branch is unreadable', () => {
    setBranch(null, 'detached HEAD');
    const { result } = render();

    expect(result.current.inputValue()).toBe('');
  });

  it('reports no pending checkout while the draft is untouched', () => {
    const { result } = render();

    expect(result.current.pending()).toBeUndefined();
  });

  it('reports no pending checkout when the draft matches the current branch or is blank', () => {
    const { result, rerender } = render();

    act(() => result.current.setInput('  master  '));
    rerender();
    expect(result.current.pending()).toBeUndefined();

    act(() => result.current.setInput('   '));
    rerender();
    expect(result.current.pending()).toBeUndefined();
  });

  it('reports the trimmed draft as the pending checkout', () => {
    const { result, rerender } = render();

    act(() => result.current.setInput('  feature  '));
    rerender();

    expect(result.current.pending()).toBe('feature');
  });

  it('clears the draft and refetches after a successful checkout', () => {
    const { result, rerender } = render();
    const done = vi.fn();

    act(() => result.current.setInput('feature'));
    rerender();
    act(() => result.current.checkout('feature', done));
    expect(mocks.mutate).toHaveBeenCalledWith({ body: { branch: 'feature' } }, expect.anything());

    setBranch('feature');
    act(() => lastHandlers().onSuccess({ body: { branch: 'feature', error: null, ccRebuildRequired: false } }));
    rerender();

    expect(result.current.inputValue()).toBe('feature');
    expect(result.current.pending()).toBeUndefined();
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft and surfaces the reason when the checkout is refused', () => {
    const { result, rerender } = render();
    const done = vi.fn();

    act(() => result.current.setInput('feature'));
    rerender();
    act(() => result.current.checkout('feature', done));
    act(() =>
      lastHandlers().onSuccess({ body: { branch: 'master', error: 'dirty working tree', ccRebuildRequired: false } }),
    );
    rerender();

    expect(result.current.inputValue()).toBe('feature');
    expect(result.current.effective()).toEqual({ branch: 'master', error: 'dirty working tree' });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('sets rebuildRequired when a clean checkout flags the cc rebuild', () => {
    setBranch('main');
    const { result } = render();
    act(() => result.current.checkout('feature-x'));
    act(() => lastHandlers().onSuccess({ body: { branch: 'feature-x', error: null, ccRebuildRequired: true } }));
    expect(result.current.rebuildRequired).toBe(true);
  });

  it('does not set rebuildRequired on a failed checkout', () => {
    setBranch('main');
    const { result } = render();
    act(() => result.current.checkout('feature-x'));
    act(() => lastHandlers().onSuccess({ body: { branch: 'main', error: 'dirty tree', ccRebuildRequired: false } }));
    expect(result.current.rebuildRequired).toBe(false);
  });

  it('keeps rebuildRequired when a later checkout fails [crg-finding: medium-local-lab-web-rebuildrequired-silently-cleared-when-a-dirty-tree-check]', () => {
    setBranch('main');
    const { result } = render();
    act(() => result.current.checkout('feature-x'));
    act(() => lastHandlers().onSuccess({ body: { branch: 'feature-x', error: null, ccRebuildRequired: true } }));
    expect(result.current.rebuildRequired).toBe(true);
    act(() => result.current.checkout('feature-y'));
    act(() =>
      lastHandlers().onSuccess({ body: { branch: 'feature-x', error: 'dirty tree', ccRebuildRequired: false } }),
    );
    expect(result.current.rebuildRequired).toBe(true);
  });

  it('surfaces a thrown checkout error and still runs the continuation', () => {
    const { result, rerender } = render();
    const done = vi.fn();

    act(() => result.current.checkout('bad..name', done));
    act(() => lastHandlers().onError({ body: { error: 'branch must not contain ".."' } }));
    rerender();

    expect(result.current.effective()).toEqual({ branch: 'master', error: 'branch must not contain ".."' });
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('falls back to a generic reason for a checkout failure with no message', () => {
    const { result, rerender } = render();

    act(() => result.current.checkout('feature'));
    act(() => lastHandlers().onError(undefined));
    rerender();

    expect(result.current.effective()?.error).toBe('invalid branch name');
  });

  it('clears a stale checkout error when the draft changes', () => {
    const { result, rerender } = render();

    act(() => result.current.checkout('feature'));
    act(() => lastHandlers().onError({ body: { error: 'dirty working tree' } }));
    rerender();
    expect(result.current.effective()?.error).toBe('dirty working tree');

    act(() => result.current.setInput('other'));
    rerender();

    expect(result.current.effective()).toEqual({ branch: 'master', error: null });
  });

  it('reports a branch query failure through the effective branch', () => {
    setQueryError(new Error('not a git repo'));
    const { result } = render();

    expect(result.current.effective()).toEqual({ branch: null, error: 'not a git repo' });
  });

  it('reports the checkout mutation as busy while it is in flight', () => {
    const { result, rerender } = render();
    expect(result.current.busy).toBe(false);

    mocks.pending = true;
    rerender();

    expect(result.current.busy).toBe(true);
  });
});
