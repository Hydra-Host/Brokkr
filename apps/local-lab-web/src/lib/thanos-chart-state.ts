export type ThanosChartInputs = { selected: boolean; hasRange: boolean; isLoading: boolean };

// a selected metric is unanchored for the render that flips the selection — the query is still
// disabled there, so isLoading is false and the chart area would render nothing at all
export function thanosChartPending({ selected, hasRange, isLoading }: ThanosChartInputs): boolean {
  return selected && (!hasRange || isLoading);
}
