import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { END_SENTINEL, SolLogReader, type SolLogList } from '../sol-log.reader';

function line(seconds: number, message: string): string {
  return JSON.stringify({ timestamp: `2026-05-30T00:00:${String(seconds).padStart(2, '0')}.000`, message });
}

describe('SolLogReader', () => {
  let reader: SolLogReader;
  let lrange: MockedFunction<SolLogList['lrange']>;
  let lindex: MockedFunction<SolLogList['lindex']>;
  let warn: MockedFunction<(message: string) => void>;

  beforeEach(() => {
    lrange = vi.fn();
    lindex = vi.fn();
    warn = vi.fn();
    lindex.mockResolvedValue(null);
    reader = new SolLogReader({ lrange, lindex }, { warn });
  });

  describe('getLogsForPlan', () => {
    it('returns parsed entries in insertion order when the list exists', async () => {
      lrange.mockResolvedValue([line(0, 'booting'), line(1, 'kernel loaded')]);

      const result = await reader.getLogsForPlan('1-2-3', 'plan-abc');

      expect(lrange).toHaveBeenCalledWith('1-2-3:sol:logs:plan-abc', 0, -1);
      expect(result.entries).toEqual([
        { timestamp: '2026-05-30T00:00:00.000', message: 'booting' },
        { timestamp: '2026-05-30T00:00:01.000', message: 'kernel loaded' },
      ]);
      expect(result.complete).toBe(false);
    });

    it('returns complete=true when the sentinel is the last entry', async () => {
      lrange.mockResolvedValue([line(0, 'booting'), line(2, END_SENTINEL)]);

      const result = await reader.getLogsForPlan('1-2-3', 'plan-abc');

      expect(result.complete).toBe(true);
      expect(result.entries).toHaveLength(2);
    });

    it('returns an empty array when the key does not exist', async () => {
      lrange.mockResolvedValue([]);

      const result = await reader.getLogsForPlan('1-2-3', 'plan-abc');

      expect(result.entries).toEqual([]);
      expect(result.complete).toBe(false);
    });

    it('skips malformed entries rather than throwing', async () => {
      lrange.mockResolvedValue([line(0, 'good'), 'not-json', JSON.stringify({ unrelated: true }), line(1, 'good 2')]);

      const result = await reader.getLogsForPlan('1-2-3', 'plan-abc');

      expect(result.entries).toEqual([
        { timestamp: '2026-05-30T00:00:00.000', message: 'good' },
        { timestamp: '2026-05-30T00:00:01.000', message: 'good 2' },
      ]);
    });
  });

  describe('getLogsPage', () => {
    it('probes the tail of the list before reading the page', async () => {
      lrange.mockResolvedValue([]);

      await reader.getLogsPage('1-2-3', 'plan-abc', 0, 500);

      expect(lindex).toHaveBeenCalledWith('1-2-3:sol:logs:plan-abc', -1);
      expect(lindex.mock.invocationCallOrder[0]).toBeLessThan(lrange.mock.invocationCallOrder[0]);
    });

    it('reads the inclusive offset range for the cursor and limit', async () => {
      lrange.mockResolvedValue([]);

      await reader.getLogsPage('1-2-3', 'plan-abc', 500, 500);

      expect(lrange).toHaveBeenCalledWith('1-2-3:sol:logs:plan-abc', 500, 999);
    });

    it('numbers each line with its absolute offset and omits the sentinel', async () => {
      lindex.mockResolvedValue(line(2, END_SENTINEL));
      lrange.mockResolvedValue([line(0, 'booting'), line(1, ' login:'), line(2, END_SENTINEL)]);

      const result = await reader.getLogsPage('1-2-3', 'plan-abc', 10, 500);

      expect(result.entries).toEqual([
        { index: 10, timestamp: '2026-05-30T00:00:00.000', message: 'booting' },
        { index: 11, timestamp: '2026-05-30T00:00:01.000', message: ' login:' },
      ]);
      expect(result.complete).toBe(true);
    });

    it('advances the cursor by the limit when the page is full', async () => {
      lrange.mockResolvedValue([line(0, 'a'), line(1, 'b')]);

      const result = await reader.getLogsPage('1-2-3', 'plan-abc', 4, 2);

      expect(result.nextCursor).toBe(6);
    });

    it('ends pagination when the page is short', async () => {
      lrange.mockResolvedValue([line(0, 'a')]);

      const result = await reader.getLogsPage('1-2-3', 'plan-abc', 4, 2);

      expect(result.nextCursor).toBeNull();
      expect(result.complete).toBe(false);
    });

    it('reports completion from the probe even when the page does not reach the sentinel', async () => {
      lindex.mockResolvedValue(line(9, END_SENTINEL));
      lrange.mockResolvedValue([line(0, 'a'), line(1, 'b')]);

      const result = await reader.getLogsPage('1-2-3', 'plan-abc', 0, 2);

      expect(result.entries).toHaveLength(2);
      expect(result.nextCursor).toBe(2);
      expect(result.complete).toBe(true);
    });

    it('returns an empty incomplete page when the key does not exist', async () => {
      lrange.mockResolvedValue([]);

      const result = await reader.getLogsPage('1-2-3', 'plan-abc', 0, 500);

      expect(result).toEqual({ entries: [], nextCursor: null, complete: false });
      expect(warn).not.toHaveBeenCalled();
    });

    it('drops a malformed item with one warning and keeps the offsets of the lines after it', async () => {
      lrange.mockResolvedValue([line(0, 'a'), 'not-json', line(2, 'c')]);

      const result = await reader.getLogsPage('1-2-3', 'plan-abc', 7, 500);

      expect(result.entries).toEqual([
        { index: 7, timestamp: '2026-05-30T00:00:00.000', message: 'a' },
        { index: 9, timestamp: '2026-05-30T00:00:02.000', message: 'c' },
      ]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('offset 8'));
    });
  });
});
