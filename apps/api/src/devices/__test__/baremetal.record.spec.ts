import { ActiveRecordRegistry } from '@repo/active-record';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaremetalRecord } from '../baremetal.record';

describe('BaremetalRecord.getDeviceIdsForHealthFilter', () => {
  const queryRaw = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    ActiveRecordRegistry.configureForTest({ $queryRaw: queryRaw }, null);
    queryRaw.mockResolvedValue([]);
  });

  afterEach(() => vi.resetAllMocks());

  it('maps the raw rows down to id strings', async () => {
    queryRaw.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    expect(await BaremetalRecord.getDeviceIdsForHealthFilter('sup-1', 'Healthy')).toEqual(['a', 'b']);
  });

  it('requires a completed run for the healthy arm instead of passing devices with no run', async () => {
    await BaremetalRecord.getDeviceIdsForHealthFilter('sup-1', 'Healthy');
    const sql = queryRaw.mock.calls[0][0].join('');
    expect(sql).toContain('lc."deviceId" IS NOT NULL AND lc."testPassed" = true');
    expect(sql).not.toContain('lc."deviceId" IS NULL');
  });

  it('pins the raw query to the supplier', async () => {
    await BaremetalRecord.getDeviceIdsForHealthFilter('sup-1', 'Unhealthy');
    expect(queryRaw.mock.calls[0]).toContain('sup-1');
  });
});
