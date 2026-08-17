import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { ThanosQueryResult, ThanosRangeResult, ThanosSample, ThanosStatus, ThanosStore } from '../contract';
import { URLS } from '../ports';

/** Raised for a query the Thanos HTTP API rejects (bad PromQL) → surfaced as 400, not 500. */
export class ThanosBadQuery extends BadRequestException {}

const SampleTuple = z.tuple([z.number(), z.string()]);
const VectorItem = z.object({ metric: z.record(z.string(), z.string()), value: SampleTuple });
const MatrixItem = z.object({ metric: z.record(z.string(), z.string()), values: z.array(SampleTuple) });

const QueryEnvelope = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    warnings: z.array(z.string()).optional(),
    data: z.discriminatedUnion('resultType', [
      z.object({ resultType: z.literal('vector'), result: z.array(VectorItem) }),
      z.object({ resultType: z.literal('matrix'), result: z.array(MatrixItem) }),
      z.object({ resultType: z.literal('scalar'), result: SampleTuple }),
      z.object({ resultType: z.literal('string'), result: SampleTuple }),
    ]),
  }),
  z.object({ status: z.literal('error'), error: z.string(), errorType: z.string().optional() }),
]);

const RangeEnvelope = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    warnings: z.array(z.string()).optional(),
    data: z.object({ resultType: z.literal('matrix'), result: z.array(MatrixItem) }),
  }),
  z.object({ status: z.literal('error'), error: z.string(), errorType: z.string().optional() }),
]);

const LabelValuesEnvelope = z.object({ status: z.literal('success'), data: z.array(z.string()) });
const BuildInfoEnvelope = z.object({ status: z.literal('success'), data: z.object({ version: z.string() }) });

const StoreEndpoint = z.object({
  name: z.string(),
  lastError: z.string().nullable().optional(),
  minTime: z.number().optional(),
  maxTime: z.number().optional(),
});
const StoresEnvelope = z.object({
  status: z.literal('success'),
  data: z.record(z.string(), z.array(StoreEndpoint)),
});

@Injectable()
export class ThanosService {
  private readonly base = process.env.DATASTORE_THANOS_URL || URLS.thanosQuery;

  private static readonly TIMEOUT_MS = 15_000;

  async probe(): Promise<boolean> {
    try {
      const res = await this.fetch('/-/ready', false);
      return res.ok;
    } catch {
      return false;
    }
  }

  private async fetch(path: string, json = true): Promise<Response> {
    return fetch(`${this.base}${path}`, {
      signal: AbortSignal.timeout(ThanosService.TIMEOUT_MS),
      headers: json ? { accept: 'application/json' } : {},
    });
  }

  private async getJson(path: string): Promise<unknown> {
    const res = await this.fetch(path);
    if (!res.ok) throw new Error(`thanos ${path} → HTTP ${res.status}`);
    return res.json();
  }

  async status(): Promise<ThanosStatus> {
    const [version, stores] = await Promise.all([this.version(), this.stores()]);
    return { version, stores };
  }

  private async version(): Promise<string> {
    try {
      const parsed = BuildInfoEnvelope.parse(await this.getJson('/api/v1/status/buildinfo'));
      return parsed.data.version;
    } catch {
      return 'unknown';
    }
  }

  private async stores(): Promise<ThanosStore[]> {
    try {
      const parsed = StoresEnvelope.parse(await this.getJson('/api/v1/stores'));
      const out: ThanosStore[] = [];
      for (const [type, endpoints] of Object.entries(parsed.data)) {
        for (const e of endpoints) {
          out.push({
            name: e.name,
            type,
            minTime: fmtMillis(e.minTime),
            maxTime: fmtMillis(e.maxTime),
            lastError: e.lastError ?? null,
          });
        }
      }
      return out.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  async metrics(match?: string): Promise<string[]> {
    const parsed = LabelValuesEnvelope.parse(await this.getJson('/api/v1/label/__name__/values'));
    const names = parsed.data.sort();
    if (!match) return names;
    const needle = match.toLowerCase();
    return names.filter((n) => n.toLowerCase().includes(needle));
  }

  async query(expr: string, time?: string): Promise<ThanosQueryResult> {
    const params = new URLSearchParams({ query: expr });
    if (time) params.set('time', time);
    const res = await this.fetch(`/api/v1/query?${params.toString()}`);
    const parsed = QueryEnvelope.parse(await res.json());
    if (parsed.status === 'error') throw new ThanosBadQuery(parsed.error);

    return {
      resultType: parsed.data.resultType,
      samples: flattenResult(parsed.data),
      warnings: parsed.warnings ?? [],
    };
  }

  async queryRange(expr: string, start: string, end: string, step: string): Promise<ThanosRangeResult> {
    const stepSec = parseStepSeconds(step);
    const startNum = Number(start);
    const endNum = Number(end);
    if (Number.isFinite(startNum) && Number.isFinite(endNum) && (endNum - startNum) / stepSec > MAX_RANGE_POINTS) {
      throw new ThanosBadQuery(
        `range too wide for step "${step}" — exceeds ${MAX_RANGE_POINTS} points; widen the step or narrow the window`,
      );
    }
    const params = new URLSearchParams({ query: expr, start, end, step: `${stepSec}s` });
    const res = await this.fetch(`/api/v1/query_range?${params.toString()}`);
    const parsed = RangeEnvelope.parse(await res.json());
    if (parsed.status === 'error') throw new ThanosBadQuery(parsed.error);

    return {
      series: parsed.data.result.map((r) => ({ metric: r.metric, points: r.values })),
      warnings: parsed.warnings ?? [],
    };
  }
}

// Prometheus's query resolution cap; Thanos's own error envelope backstops RFC3339 start/end inputs.
const MAX_RANGE_POINTS = 11_000;

const STEP_UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86_400 };

export function parseStepSeconds(step: string): number {
  const match = /^(\d+)([smhd]?)$/.exec(step.trim());
  if (!match?.[1]) {
    throw new ThanosBadQuery(
      `invalid step "${step}" — use plain seconds ("30") or a duration ("30s", "5m", "2h", "1d")`,
    );
  }
  const seconds = Number(match[1]) * (STEP_UNIT_SECONDS[match[2] ?? ''] ?? 1);
  if (seconds < 1) throw new ThanosBadQuery(`step must be at least 1s, got "${step}"`);
  return seconds;
}

type QueryData = Extract<z.infer<typeof QueryEnvelope>, { status: 'success' }>['data'];

function flattenResult(data: QueryData): ThanosSample[] {
  if (data.resultType === 'vector') {
    return data.result.map((r) => ({ metric: r.metric, value: r.value[1], timestamp: r.value[0] }));
  }
  if (data.resultType === 'matrix') {
    return data.result.flatMap((r) => {
      const last = r.values.at(-1);
      return last ? [{ metric: r.metric, value: last[1], timestamp: last[0] }] : [];
    });
  }
  return [{ metric: {}, value: data.result[1], timestamp: data.result[0] }];
}

const MAX_REAL_MS = 4_102_444_800_000;
const MIN_REAL_MS = 946_684_800_000;

function fmtMillis(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms > MAX_REAL_MS || ms < MIN_REAL_MS) return '—';
  return new Date(ms)
    .toISOString()
    .replace('T', ' ')
    .replace(/\.\d+Z$/, 'Z');
}
