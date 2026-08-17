import { describe, expect, it } from 'vitest';

import type { ThanosRangeSeries } from '@/contract';

import { toUplotData } from './uplot-data';

const series = (points: [number, string][]): ThanosRangeSeries => ({ metric: { __name__: 'm' }, points });

describe('toUplotData', () => {
  it('aligns series over the union of timestamps with null gaps', () => {
    const { xs, ys } = toUplotData([
      series([
        [10, '1'],
        [20, '2'],
      ]),
      series([
        [20, '5'],
        [30, '6'],
      ]),
    ]);
    expect(xs).toEqual([10, 20, 30]);
    expect(ys).toEqual([
      [1, 2, null],
      [null, 5, 6],
    ]);
  });

  it('passes a single series through', () => {
    const { xs, ys } = toUplotData([
      series([
        [1, '0.5'],
        [2, '1.5'],
      ]),
    ]);
    expect(xs).toEqual([1, 2]);
    expect(ys).toEqual([[0.5, 1.5]]);
  });

  it('maps non-numeric values to null', () => {
    const { ys } = toUplotData([
      series([
        [1, 'NaN'],
        [2, 'nope'],
        [3, '2'],
      ]),
    ]);
    expect(ys).toEqual([[null, null, 2]]);
  });

  it('returns empty data for an empty series list', () => {
    expect(toUplotData([])).toEqual({ xs: [], ys: [] });
  });

  it('sorts unsorted input timestamps', () => {
    const { xs, ys } = toUplotData([
      series([
        [30, '3'],
        [10, '1'],
        [20, '2'],
      ]),
    ]);
    expect(xs).toEqual([10, 20, 30]);
    expect(ys).toEqual([[1, 2, 3]]);
  });
});
