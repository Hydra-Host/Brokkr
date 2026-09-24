import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { SolLogService, type SolLogListReader } from '../sol-log.service';

function line(seconds: number, message: string): string {
  return JSON.stringify({ timestamp: `2026-05-30T00:00:${String(seconds).padStart(2, '0')}.000`, message });
}

describe('SolLogService', () => {
  let service: SolLogService;
  let lrange: MockedFunction<SolLogListReader['lrange']>;
  let lindex: MockedFunction<SolLogListReader['lindex']>;
  let warn: MockedFunction<(message: string) => void>;

  beforeEach(() => {
    lrange = vi.fn();
    lindex = vi.fn();
    warn = vi.fn();
    lindex.mockResolvedValue(null);
    service = new SolLogService({ lrange, lindex }, { warn });
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

  describe('getLogsPage', () => {
    it('probes the tail of the list before reading the page', async () => {
      lrange.mockResolvedValue([]);

      await service.getLogsPage('1-2-3', 'plan-abc', 0, 500);

      expect(lindex).toHaveBeenCalledWith('1-2-3:sol:logs:plan-abc', -1);
      expect(lindex.mock.invocationCallOrder[0]).toBeLessThan(lrange.mock.invocationCallOrder[0]);
    });

    it('reads the inclusive offset range for the cursor and limit', async () => {
      lrange.mockResolvedValue([]);

      await service.getLogsPage('1-2-3', 'plan-abc', 500, 500);

      expect(lrange).toHaveBeenCalledWith('1-2-3:sol:logs:plan-abc', 500, 999);
    });

    it('numbers each line with its absolute offset and omits the sentinel', async () => {
      lindex.mockResolvedValue(line(2, 'END LOG COLLECTION'));
      lrange.mockResolvedValue([line(0, 'booting'), line(1, ' login:'), line(2, 'END LOG COLLECTION')]);

      const result = await service.getLogsPage('1-2-3', 'plan-abc', 10, 500);

      expect(result.entries).toEqual([
        { index: 10, timestamp: '2026-05-30T00:00:00.000', message: 'booting' },
        { index: 11, timestamp: '2026-05-30T00:00:01.000', message: ' login:' },
      ]);
      expect(result.complete).toBe(true);
    });

    it('advances the cursor by the limit when the page is full', async () => {
      lrange.mockResolvedValue([line(0, 'a'), line(1, 'b')]);

      const result = await service.getLogsPage('1-2-3', 'plan-abc', 4, 2);

      expect(result.nextCursor).toBe(6);
    });

    it('ends pagination when the page is short', async () => {
      lrange.mockResolvedValue([line(0, 'a')]);

      const result = await service.getLogsPage('1-2-3', 'plan-abc', 4, 2);

      expect(result.nextCursor).toBeNull();
      expect(result.complete).toBe(false);
    });

    it('reports completion from the probe even when the page does not reach the sentinel', async () => {
      lindex.mockResolvedValue(line(9, 'END LOG COLLECTION'));
      lrange.mockResolvedValue([line(0, 'a'), line(1, 'b')]);

      const result = await service.getLogsPage('1-2-3', 'plan-abc', 0, 2);

      expect(result.entries).toHaveLength(2);
      expect(result.nextCursor).toBe(2);
      expect(result.complete).toBe(true);
    });

    it('returns an empty incomplete page when the key does not exist', async () => {
      lrange.mockResolvedValue([]);

      const result = await service.getLogsPage('1-2-3', 'plan-abc', 0, 500);

      expect(result).toEqual({ entries: [], nextCursor: null, complete: false });
      expect(warn).not.toHaveBeenCalled();
    });

    it('drops a malformed item with one warning and keeps the offsets of the lines after it', async () => {
      lrange.mockResolvedValue([line(0, 'a'), 'not-json', line(2, 'c')]);

      const result = await service.getLogsPage('1-2-3', 'plan-abc', 7, 500);

      expect(result.entries).toEqual([
        { index: 7, timestamp: '2026-05-30T00:00:00.000', message: 'a' },
        { index: 9, timestamp: '2026-05-30T00:00:02.000', message: 'c' },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('offset 8'));
    });
  });
});
