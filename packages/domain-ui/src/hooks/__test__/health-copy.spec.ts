import type { DeviceHealthSummary } from '@repo/api-client';
import { describe, expect, it } from 'vitest';
import { healthRequestMessage, healthSummaryLine, relativeTime } from '../health-copy';

const NOW = Date.UTC(2026, 8, 16, 12, 0, 0);
const summary = (over: Partial<DeviceHealthSummary>): DeviceHealthSummary => ({
  view: 'owner',
  source: 'none',
  checkedAt: null,
  checks: null,
  isHealthy: null,
  reason: null,
  icmpFiltered: false,
  ...over,
});

describe('relativeTime', () => {
  it('rounds to minutes, hours and days', () => {
    expect(relativeTime('2026-09-16T11:56:00.000Z', NOW)).toBe('4 min ago');
    expect(relativeTime('2026-09-16T09:00:00.000Z', NOW)).toBe('3 h ago');
    expect(relativeTime('2026-09-13T12:00:00.000Z', NOW)).toBe('3 days ago');
  });
});

describe('healthSummaryLine', () => {
  it('says when nothing is known', () => {
    expect(healthSummaryLine(summary({}), NOW)).toBe('No health check is known for this device.');
  });

  it('distinguishes a live snapshot from a stale change', () => {
    expect(healthSummaryLine(summary({ source: 'snapshot', checkedAt: '2026-09-16T11:56:00.000Z' }), NOW)).toBe(
      'Last checked 4 min ago.',
    );
    expect(healthSummaryLine(summary({ source: 'history', checkedAt: '2026-09-14T12:00:00.000Z' }), NOW)).toBe(
      'Last change 2 days ago. No check result in the last 10 minutes is known.',
    );
  });
});

describe('healthRequestMessage', () => {
  it('prefers the api message and falls back per status', () => {
    expect(healthRequestMessage({ status: 409, body: { message: 'rejected at 11:21' } })).toBe('rejected at 11:21');
    expect(healthRequestMessage({ status: 400 })).toBe('The bridge cannot probe this device.');
    expect(healthRequestMessage({ status: 403 })).toBe('You do not have permission to perform this action.');
    expect(healthRequestMessage({ status: 429 })).toBe(
      'A check was requested less than five minutes ago. The scheduled check runs every five minutes.',
    );
    expect(healthRequestMessage(new Error('x'))).toBe('The health check could not be requested.');
  });
});
