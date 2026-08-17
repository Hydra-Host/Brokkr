import { describe, expect, it } from 'vitest';

import { rowRangeLabel } from './row-range';

describe('rowRangeLabel', () => {
  it('numbers the rows of a full page from its offset', () => {
    expect(rowRangeLabel(0, 100, 100)).toBe('rows 1–100');
    expect(rowRangeLabel(3, 100, 100)).toBe('rows 301–400');
  });

  it('numbers a partial last page', () => {
    expect(rowRangeLabel(2, 100, 40)).toBe('rows 201–240');
    expect(rowRangeLabel(0, 100, 1)).toBe('rows 1–1');
  });

  it('does not invert the range on a page past the last row', () => {
    expect(rowRangeLabel(500, 100, 0)).toBe('no rows');
  });

  it('does not invert the range on an empty table', () => {
    expect(rowRangeLabel(0, 100, 0)).toBe('no rows');
  });
});
