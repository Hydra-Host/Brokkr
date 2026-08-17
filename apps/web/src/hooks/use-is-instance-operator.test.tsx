import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useIsInstanceOperator } from './use-is-instance-operator';

const { useHostContextQuery } = vi.hoisted(() => ({
  useHostContextQuery: vi.fn(),
}));

vi.mock('~/lib/api', () => ({
  tsr: {
    getPluginHostContext: {
      useQuery: useHostContextQuery,
    },
  },
}));

describe('useIsInstanceOperator', () => {
  beforeEach(() => {
    useHostContextQuery.mockReset();
  });

  it('returns true only when the server confirms operator capability', () => {
    useHostContextQuery.mockReturnValue({
      data: { status: 200, body: { isInstanceOperator: true } },
      isPending: false,
    });

    const { result } = renderHook(() => useIsInstanceOperator());

    expect(result.current).toEqual({ isInstanceOperator: true, isPending: false });
  });

  it('fails closed for a non-operator response', () => {
    useHostContextQuery.mockReturnValue({
      data: { status: 200, body: { isInstanceOperator: false } },
      isPending: false,
    });

    const { result } = renderHook(() => useIsInstanceOperator());

    expect(result.current).toEqual({ isInstanceOperator: false, isPending: false });
  });

  it('fails closed while capability is loading', () => {
    useHostContextQuery.mockReturnValue({ data: undefined, isPending: true });

    const { result } = renderHook(() => useIsInstanceOperator());

    expect(result.current).toEqual({ isInstanceOperator: false, isPending: true });
  });
});
