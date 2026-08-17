import type { ThanosQueryResult, ThanosRangeResult, ThanosSample } from '@/contract';

export const THANOS_WINDOWS = ['15m', '1h', '6h', '24h'] as const;
export type ThanosWindow = (typeof THANOS_WINDOWS)[number];

export const THANOS_WINDOW_SECONDS: Record<ThanosWindow, number> = {
  '15m': 900,
  '1h': 3_600,
  '6h': 21_600,
  '24h': 86_400,
};

export function rangeWindowQuery(win: ThanosWindow, nowMs: number): { start: string; end: string; step: string } {
  const rangeSec = THANOS_WINDOW_SECONDS[win];
  const stepSec = Math.max(15, Math.round(rangeSec / 200));
  const nowSec = Math.floor(nowMs / 1000);
  return { start: String(nowSec - rangeSec), end: String(nowSec), step: `${stepSec}s` };
}

export function rangeLatestResult(result: ThanosRangeResult): ThanosQueryResult {
  const samples: ThanosSample[] = [];
  for (const s of result.series) {
    const last = s.points.at(-1);
    if (last) samples.push({ metric: s.metric, value: last[1], timestamp: last[0] });
  }
  return { resultType: 'matrix', samples, warnings: result.warnings };
}
