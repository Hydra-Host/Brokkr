import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCopyToClipboard } from '@repo/ui/hooks/use-copy-to-clipboard';

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { toast } from 'sonner';

const writeText = vi.fn<(value: string) => Promise<void>>();

beforeEach(() => {
  vi.useFakeTimers();
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('useCopyToClipboard', () => {
  it('writes to the clipboard and clears copied state after the timeout', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => result.current.copy('secret'));

    expect(writeText).toHaveBeenCalledWith('secret');
    expect(result.current.copied).toBe(true);

    act(() => vi.advanceTimersByTime(2000));
    expect(result.current.copied).toBe(false);
  });

  it('tracks which target was copied via copiedKey', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => result.current.copy('hunter2', 'password'));

    expect(result.current.copiedKey).toBe('password');
    expect(result.current.copied).toBe(true);
  });

  it('restarts the timeout when a second copy happens before the first expires', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => result.current.copy('a', 'first'));
    act(() => vi.advanceTimersByTime(1500));
    await act(async () => result.current.copy('b', 'second'));

    act(() => vi.advanceTimersByTime(1500));
    expect(result.current.copiedKey).toBe('second');

    act(() => vi.advanceTimersByTime(500));
    expect(result.current.copiedKey).toBeNull();
  });

  it('respects a custom timeout', async () => {
    const { result } = renderHook(() => useCopyToClipboard(500));

    await act(async () => result.current.copy('x'));
    act(() => vi.advanceTimersByTime(499));
    expect(result.current.copied).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.copied).toBe(false);
  });

  it('reset clears copied state immediately', async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => result.current.copy('x'));
    act(() => result.current.reset());

    expect(result.current.copied).toBe(false);
    expect(result.current.copiedKey).toBeNull();
  });

  it('surfaces a toast and stays un-copied when the clipboard write rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    writeText.mockRejectedValue(new Error('denied'));
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => result.current.copy('x'));

    expect(toast.error).toHaveBeenCalledWith('Failed to copy to clipboard');
    expect(consoleError).toHaveBeenCalled();
    expect(result.current.copied).toBe(false);
    consoleError.mockRestore();
  });
});
