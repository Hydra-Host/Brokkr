import type { ThanosRangeSeries } from '@/contract';

export function toUplotData(series: ThanosRangeSeries[]): { xs: number[]; ys: (number | null)[][] } {
  const stamps = new Set<number>();
  for (const s of series) {
    for (const [ts] of s.points) stamps.add(ts);
  }
  const xs = [...stamps].sort((a, b) => a - b);
  const indexOf = new Map(xs.map((ts, i): [number, number] => [ts, i]));
  const ys = series.map((s) => {
    const row = new Array<number | null>(xs.length).fill(null);
    for (const [ts, value] of s.points) {
      const num = Number(value);
      row[indexOf.get(ts)!] = Number.isNaN(num) ? null : num;
    }
    return row;
  });
  return { xs, ys };
}
