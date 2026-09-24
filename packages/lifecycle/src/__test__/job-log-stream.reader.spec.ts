import { beforeEach, describe, expect, it, vi, type MockedFunction } from 'vitest';
import { JobLogStreamReader, type JobLogStream } from '../job-log-stream.reader';

const ZONE = '11111111-1111-1111-1111-111111111111';
const PLAN = '0b0e8f7a-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
const KEY = `${ZONE}:job:logs:${PLAN}`;

function entryFields(over: Partial<Record<string, string>> = {}): string[] {
  const base: Record<string, string> = {
    timestamp: '2026-08-28T00:00:00.000Z',
    log_level: 'info',
    message: 'step complete',
    app_name: 'brokkr-hub',
    app_class_name: 'BridgeResultsConsumer',
    ...over,
  };
  return Object.entries(base).flat();
}

describe('JobLogStreamReader', () => {
  let reader: JobLogStreamReader;
  let xrange: MockedFunction<JobLogStream['xrange']>;
  let warn: MockedFunction<(message: string) => void>;

  beforeEach(() => {
    xrange = vi.fn();
    warn = vi.fn();
    xrange.mockResolvedValue([]);
    reader = new JobLogStreamReader({ xrange }, { warn });
  });

  it('reads from the start without a cursor and exclusively after the cursor with one', async () => {
    await reader.readPage(ZONE, PLAN, undefined, 100);
    await reader.readPage(ZONE, PLAN, '1700000000000-5', 100);

    expect(xrange).toHaveBeenNthCalledWith(1, KEY, '-', '+', 'COUNT', 100);
    expect(xrange).toHaveBeenNthCalledWith(2, KEY, '(1700000000000-5', '+', 'COUNT', 100);
  });

  it('maps stream fields onto the response entry', async () => {
    xrange.mockResolvedValue([['1-1', entryFields()]]);

    const result = await reader.readPage(ZONE, PLAN, undefined, 100);

    expect(result.entries).toEqual([
      {
        id: '1-1',
        timestamp: '2026-08-28T00:00:00.000Z',
        logLevel: 'info',
        message: 'step complete',
        appName: 'brokkr-hub',
        appClassName: 'BridgeResultsConsumer',
      },
    ]);
  });

  it('returns a null nextCursor on a short page', async () => {
    xrange.mockResolvedValue([['1-1', entryFields()]]);

    const result = await reader.readPage(ZONE, PLAN, undefined, 2);

    expect(result.nextCursor).toBeNull();
    expect(result.entries).toHaveLength(1);
  });

  it('returns the last stream id as nextCursor on a full page', async () => {
    xrange.mockResolvedValue([
      ['1-1', entryFields()],
      ['1-2', entryFields({ message: 'second' })],
    ]);

    const result = await reader.readPage(ZONE, PLAN, undefined, 2);

    expect(result.nextCursor).toBe('1-2');
    expect(result.entries.map((entry) => entry.id)).toEqual(['1-1', '1-2']);
  });

  it('drops a malformed entry with one warning and advances the cursor off the raw length', async () => {
    xrange.mockResolvedValue([
      ['1-1', entryFields()],
      ['1-2', ['timestamp', '2026-08-28T00:00:01.000Z', 'log_level', 'info']],
      ['1-3', entryFields({ message: 'third' })],
    ]);

    const result = await reader.readPage(ZONE, PLAN, undefined, 3);

    expect(result.entries.map((entry) => entry.id)).toEqual(['1-1', '1-3']);
    expect(result.nextCursor).toBe('1-3');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('1-2'));
  });

  it('returns an empty page when the stream does not exist', async () => {
    const result = await reader.readPage(ZONE, PLAN, undefined, 100);

    expect(result).toEqual({ entries: [], nextCursor: null });
    expect(warn).not.toHaveBeenCalled();
  });
});
