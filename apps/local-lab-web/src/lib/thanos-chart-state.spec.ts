import { describe, expect, it } from 'vitest';

import { thanosChartPending } from './thanos-chart-state';

type RenderState = {
  name: string;
  selected: boolean;
  hasRange: boolean;
  isLoading: boolean;
  hasError: boolean;
  hasBody: boolean;
};

const SELECTED_STATES: RenderState[] = [
  {
    name: 'selection flipped, anchor not yet taken',
    selected: true,
    hasRange: false,
    isLoading: false,
    hasError: false,
    hasBody: false,
  },
  { name: 'anchored and fetching', selected: true, hasRange: true, isLoading: true, hasError: false, hasBody: false },
  { name: 'loaded', selected: true, hasRange: true, isLoading: false, hasError: false, hasBody: true },
  {
    name: 'range advance refetching behind placeholder data',
    selected: true,
    hasRange: true,
    isLoading: false,
    hasError: false,
    hasBody: true,
  },
  { name: 'failed', selected: true, hasRange: true, isLoading: false, hasError: true, hasBody: false },
];

describe('thanosChartPending', () => {
  it.each(SELECTED_STATES)('never leaves the chart area empty while selected: $name', (state) => {
    const pending = thanosChartPending(state);
    expect(pending || state.hasError || state.hasBody).toBe(true);
  });

  it('treats an unanchored selection as pending', () => {
    expect(thanosChartPending({ selected: true, hasRange: false, isLoading: false })).toBe(true);
  });

  it('stays quiet while placeholder data covers a range advance', () => {
    expect(thanosChartPending({ selected: true, hasRange: true, isLoading: false })).toBe(false);
  });

  it('is never pending without a selection', () => {
    expect(thanosChartPending({ selected: false, hasRange: false, isLoading: false })).toBe(false);
    expect(thanosChartPending({ selected: false, hasRange: false, isLoading: true })).toBe(false);
  });
});
