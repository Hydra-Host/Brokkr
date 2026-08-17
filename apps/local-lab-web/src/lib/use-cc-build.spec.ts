// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useQuery: vi.fn() }));
vi.mock('@/lib/api', () => ({ tsr: { getHost: { useQuery: mocks.useQuery } } }));

import { useCcBuild } from './use-cc-build';

const ccBuild = { sha: 'aaa', builtAt: 1, headSha: 'bbb', stale: true };

describe('useCcBuild', () => {
  afterEach(() => cleanup());

  it('returns the ccBuild block from a 200 host response', () => {
    mocks.useQuery.mockReturnValue({ data: { status: 200, body: { ccBuild } } });
    const { result } = renderHook(() => useCcBuild());
    expect(result.current.ccBuild).toEqual(ccBuild);
  });

  it('returns null until the host response lands', () => {
    mocks.useQuery.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useCcBuild());
    expect(result.current.ccBuild).toBeNull();
  });

  it('polls on a 10s interval against the shared host query', () => {
    mocks.useQuery.mockReturnValue({ data: undefined });
    renderHook(() => useCcBuild());
    expect(mocks.useQuery).toHaveBeenCalledWith({ queryKey: ['host'], refetchInterval: 10_000 });
  });
});
