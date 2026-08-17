import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

import type { ThanosRangeSeries } from '@/contract';
import { toUplotData } from '@/lib/uplot-data';

const MAX_SERIES = 20;

const PALETTE_TOKENS: [token: string, fallback: string][] = [
  ['--color-accent', '#eceaff'],
  ['--color-status-online', '#6fec4f'],
  ['--color-status-info', '#60a5fa'],
  ['--color-status-warning', '#fbd424'],
  ['--color-status-price', '#ff8400'],
  ['--color-status-purple', '#c084fc'],
];

type ThemeColors = { palette: string[]; grid: string; text: string };

function readThemeColors(): ThemeColors {
  const styles = getComputedStyle(document.documentElement);
  const read = (token: string, fallback: string) => styles.getPropertyValue(token).trim() || fallback;
  return {
    palette: PALETTE_TOKENS.map(([token, fallback]) => read(token, fallback)),
    grid: read('--color-border-dim', '#2e2a42'),
    text: read('--color-text-dim', '#706b8e'),
  };
}

function sameColors(a: ThemeColors, b: ThemeColors): boolean {
  return a.grid === b.grid && a.text === b.text && a.palette.every((c, i) => c === b.palette[i]);
}

// observing `data-theme` beats a useTheme() dep: the provider sets that attribute in an effect that
// runs after this subtree's, so a render-time read of the CSS vars would lag one theme switch behind.
function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState(readThemeColors);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setColors((prev) => {
        const next = readThemeColors();
        return sameColors(prev, next) ? prev : next;
      });
    });
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return colors;
}

function seriesLabel(metric: Record<string, string>): string {
  const { __name__: name = '', ...labels } = metric;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`);
  if (parts.length === 0) return name || '(scalar)';
  return `${name}{${parts.join(',')}}`;
}

export function ThanosChart({ series, height = 260 }: { series: ThanosRangeSeries[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const colors = useThemeColors();
  const shown = useMemo(() => series.slice(0, MAX_SERIES), [series]);
  const extra = series.length - shown.length;

  useEffect(() => {
    const el = containerRef.current;
    if (!el || shown.length === 0) return;
    const { xs, ys } = toUplotData(shown);
    const data: uPlot.AlignedData = [xs, ...ys];
    const axis: uPlot.Axis = {
      stroke: colors.text,
      grid: { stroke: colors.grid, width: 1 },
      ticks: { stroke: colors.grid, width: 1 },
    };
    const opts: uPlot.Options = {
      width: el.clientWidth || 640,
      height,
      legend: { show: false },
      axes: [axis, { ...axis }],
      series: [
        {},
        ...shown.map(
          (s, i): uPlot.Series => ({
            label: seriesLabel(s.metric),
            stroke: colors.palette[i % colors.palette.length],
            width: 1.5,
          }),
        ),
      ],
    };
    const chart = new uPlot(opts, data, el);
    const observer = new ResizeObserver(() => {
      chart.setSize({ width: el.clientWidth, height });
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.destroy();
    };
  }, [shown, height, colors]);

  if (shown.length === 0) return <div className="text-text-dim text-sm">no data</div>;

  return (
    <div className="space-y-2">
      <div className="border-border-dim bg-bg-secondary rounded-lg border p-2">
        <div ref={containerRef} className="min-w-0" />
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {shown.map((s, i) => (
          <span key={i} className="text-text-muted inline-flex items-center gap-1.5 font-mono text-[11px]">
            <span
              className="h-2 w-2 shrink-0 rounded-sm"
              style={{ backgroundColor: colors.palette[i % colors.palette.length] }}
            />
            <span className="break-all">{seriesLabel(s.metric)}</span>
          </span>
        ))}
      </div>
      {extra > 0 && <div className="text-text-dim font-mono text-[11px]">+{extra} more series</div>}
    </div>
  );
}
