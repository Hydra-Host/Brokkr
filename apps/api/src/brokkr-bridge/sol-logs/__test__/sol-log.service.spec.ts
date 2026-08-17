import { type Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { SolLogService } from '../sol-log.service';

describe('SolLogService', () => {
  let service: SolLogService;
  let lrange: MockedFunction<Redis['lrange']>;
  let redis: Redis;

  beforeEach(() => {
    lrange = vi.fn();
    redis = { lrange } as unknown as Redis;
    service = new SolLogService(redis);
  });

  describe('getLogsForPlan', () => {
    it('returns parsed entries in insertion order when the list exists', async () => {
      lrange.mockResolvedValue([
        JSON.stringify({ timestamp: '2026-05-30T00:00:00.000', message: 'booting' }),
        JSON.stringify({ timestamp: '2026-05-30T00:00:01.000', message: 'kernel loaded' }),
      ]);

      const result = await service.getLogsForPlan('1-2-3', 'plan-abc');

      expect(lrange).toHaveBeenCalledWith('1-2-3:sol:logs:plan-abc', 0, -1);
      expect(result.entries).toEqual([
        { timestamp: '2026-05-30T00:00:00.000', message: 'booting' },
        { timestamp: '2026-05-30T00:00:01.000', message: 'kernel loaded' },
      ]);
      expect(result.complete).toBe(false);
    });

    it('returns complete=true when the END LOG COLLECTION sentinel is the last entry', async () => {
      lrange.mockResolvedValue([
        JSON.stringify({ timestamp: '2026-05-30T00:00:00.000', message: 'booting' }),
        JSON.stringify({ timestamp: '2026-05-30T00:00:02.000', message: 'END LOG COLLECTION' }),
      ]);

      const result = await service.getLogsForPlan('1-2-3', 'plan-abc');

      expect(result.complete).toBe(true);
      expect(result.entries).toHaveLength(2);
    });

    it('returns an empty array when the key does not exist', async () => {
      lrange.mockResolvedValue([]);

      const result = await service.getLogsForPlan('1-2-3', 'plan-abc');

      expect(result.entries).toEqual([]);
      expect(result.complete).toBe(false);
    });

    it('skips malformed entries rather than throwing', async () => {
      lrange.mockResolvedValue([
        JSON.stringify({ timestamp: '2026-05-30T00:00:00.000', message: 'good' }),
        'not-json',
        JSON.stringify({ unrelated: true }),
        JSON.stringify({ timestamp: '2026-05-30T00:00:01.000', message: 'good 2' }),
      ]);

      const result = await service.getLogsForPlan('1-2-3', 'plan-abc');

      expect(result.entries).toEqual([
        { timestamp: '2026-05-30T00:00:00.000', message: 'good' },
        { timestamp: '2026-05-30T00:00:01.000', message: 'good 2' },
      ]);
    });
  });
});
