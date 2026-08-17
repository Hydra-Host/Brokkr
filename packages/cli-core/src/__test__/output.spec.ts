import { describe, expect, it, vi } from 'vitest';
import { getErrorMessage, renderJson } from '../index.js';

describe('output', () => {
  it('renderJson pretty-prints to stdout', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    renderJson({ a: 1 });
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ a: 1 }, null, 2));
    spy.mockRestore();
  });

  it('getErrorMessage extracts Error.message and stringifies non-errors', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
    expect(getErrorMessage('nope')).toBe('nope');
  });
});
