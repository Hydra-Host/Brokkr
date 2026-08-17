import { describe, expect, it, vi } from 'vitest';
import { renderTable } from '../index.js';

describe('renderTable', () => {
  it('draws a box-drawing table with headers and rows', () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((s?: unknown) => { lines.push(String(s)); });
    renderTable([{ header: 'ID', get: (r: { id: string }) => r.id }], [{ id: 'abc' }]);
    spy.mockRestore();
    const out = lines.join('\n');
    expect(out).toContain('┌');
    expect(out).toContain('ID');
    expect(out).toContain('abc');
  });
});
