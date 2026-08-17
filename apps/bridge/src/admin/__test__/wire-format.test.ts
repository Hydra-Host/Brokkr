import { describe, expect, it } from 'vitest';

import type { CronStateSnapshot } from '../cron-state.js';
import { isoformatUtc, renderCronStatesJson } from '../wire-format.js';

describe('isoformatUtc', () => {
  it('emits `+00:00` and omits the fractional part when ms is zero', () => {
    expect(isoformatUtc(new Date('2026-06-12T10:00:00.000Z'))).toBe('2026-06-12T10:00:00+00:00');
  });

  it('pads ms to six digits (microsecond width) when non-zero', () => {
    expect(isoformatUtc(new Date('2026-06-13T07:31:46.807Z'))).toBe('2026-06-13T07:31:46.807000+00:00');
  });

  it('pads ms to three digits before microsecond expansion', () => {
    expect(isoformatUtc(new Date('2026-06-13T07:31:46.005Z'))).toBe('2026-06-13T07:31:46.005000+00:00');
  });

  it('zero-pads date components to fixed widths', () => {
    expect(isoformatUtc(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05+00:00');
  });
});

describe('renderCronStatesJson', () => {
  it('emits `[]\\n` for an empty list', () => {
    expect(renderCronStatesJson([])).toBe('[]\n');
  });

  it('emits keys alphabetically with compact separators and a float-typed interval_seconds', () => {
    const snapshot: CronStateSnapshot = {
      name: 'asset-sync',
      intervalSeconds: 300,
      lastRunAt: new Date('2026-06-12T10:00:00.000Z'),
      lastSuccessAt: null,
      nextRunAt: new Date('2026-06-12T10:05:00.000Z'),
      lastError: "RuntimeError('sync failed')",
      consecutiveFailures: 2,
      running: false,
    };
    const expected =
      '[{' +
      '"consecutive_failures":2,' +
      '"interval_seconds":300.0,' +
      '"last_error":"RuntimeError(\'sync failed\')",' +
      '"last_run_at":"2026-06-12T10:00:00+00:00",' +
      '"last_success_at":null,' +
      '"name":"asset-sync",' +
      '"next_run_at":"2026-06-12T10:05:00+00:00",' +
      '"running":false' +
      '}]\n';
    expect(renderCronStatesJson([snapshot])).toBe(expected);
  });

  it('preserves non-whole interval_seconds without forcing a trailing `.0`', () => {
    const snapshot: CronStateSnapshot = {
      name: 'fast',
      intervalSeconds: 0.5,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      lastError: null,
      consecutiveFailures: 0,
      running: true,
    };
    expect(renderCronStatesJson([snapshot])).toBe(
      '[{' +
        '"consecutive_failures":0,' +
        '"interval_seconds":0.5,' +
        '"last_error":null,' +
        '"last_run_at":null,' +
        '"last_success_at":null,' +
        '"name":"fast",' +
        '"next_run_at":null,' +
        '"running":true' +
        '}]\n',
    );
  });

  it('escapes non-ASCII string content as `\\uXXXX` (BMP and surrogate pairs)', () => {
    const snapshot: CronStateSnapshot = {
      name: 'cafe é emoji 😀',
      intervalSeconds: 1,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      lastError: "RuntimeError('boom \x7f \x80 \x1f \\ \"')",
      consecutiveFailures: 0,
      running: false,
    };
    expect(renderCronStatesJson([snapshot])).toBe(
      '[{' +
        '"consecutive_failures":0,' +
        '"interval_seconds":1.0,' +
        '"last_error":"RuntimeError(\'boom \\u007f \\u0080 \\u001f \\\\ \\"\')",' +
        '"last_run_at":null,' +
        '"last_success_at":null,' +
        '"name":"cafe \\u00e9 emoji \\ud83d\\ude00",' +
        '"next_run_at":null,' +
        '"running":false' +
        '}]\n',
    );
  });

  it('renders interval_seconds at the fixed/scientific-notation thresholds', () => {
    const cases: Array<[number, string]> = [
      [1e16, '1e+16'],
      [1e100, '1e+100'],
      [1e-6, '1e-06'],
      [1e-7, '1e-07'],
      [9.99e-5, '9.99e-05'],
      [1e-4, '0.0001'],
      [9e15, '9000000000000000.0'],
    ];
    for (const [interval, expectedInterval] of cases) {
      const snapshot: CronStateSnapshot = {
        name: 'edge',
        intervalSeconds: interval,
        lastRunAt: null,
        lastSuccessAt: null,
        nextRunAt: null,
        lastError: null,
        consecutiveFailures: 0,
        running: false,
      };
      expect(renderCronStatesJson([snapshot])).toBe(
        '[{' +
          '"consecutive_failures":0,' +
          `"interval_seconds":${expectedInterval},` +
          '"last_error":null,' +
          '"last_run_at":null,' +
          '"last_success_at":null,' +
          '"name":"edge",' +
          '"next_run_at":null,' +
          '"running":false' +
          '}]\n',
      );
    }
  });

  it('joins multiple states with `,` and no spacing', () => {
    const a: CronStateSnapshot = {
      name: 'a',
      intervalSeconds: 1,
      lastRunAt: null,
      lastSuccessAt: null,
      nextRunAt: null,
      lastError: null,
      consecutiveFailures: 0,
      running: false,
    };
    const b: CronStateSnapshot = { ...a, name: 'b' };
    const body = renderCronStatesJson([a, b]);
    expect(body.startsWith('[{')).toBe(true);
    expect(body.endsWith('}]\n')).toBe(true);
    expect(body.split('},{').length).toBe(2);
  });
});
