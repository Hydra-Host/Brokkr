import type { ConfigService } from '@nestjs/config';
import type { PrismaClient } from 'src/prisma/prisma.client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  BATCH_SIZE,
  DEFAULT_RETENTION_DAYS,
  EventLogRetentionCron,
  MAX_BATCHES_PER_TABLE,
  resolveRetentionDays,
} from '../event-log-retention.cron';

const DAY_MS = 24 * 60 * 60 * 1000;

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), verbose: vi.fn() };

function build(options: { executeRaw: Mock; eventLogRemaining?: number; bucketRemaining?: number; days?: string }) {
  const eventLogCount = vi.fn().mockResolvedValue(options.eventLogRemaining ?? 0);
  const bucketCount = vi.fn().mockResolvedValue(options.bucketRemaining ?? 0);
  const prisma = {
    $executeRaw: options.executeRaw,
    eventLog: { count: eventLogCount },
    eventLogAccessBucket: { count: bucketCount },
  };
  const configService = { get: vi.fn().mockReturnValue(options.days) };
  const cron = new EventLogRetentionCron(
    prisma as unknown as PrismaClient,
    configService as unknown as ConfigService,
    logger as never,
  );
  return { cron, eventLogCount, bucketCount, configService };
}

const tableOf = (call: unknown[]): string =>
  call
    .slice(1)
    .filter(
      (value): value is { strings: string[] } => typeof value === 'object' && value !== null && 'strings' in value,
    )
    .map((fragment) => fragment.strings.join(''))[0];

const cutoffOf = (call: unknown[]): Date | undefined =>
  call.slice(1).find((value): value is Date => value instanceof Date);

async function cutoffFor(days: string | undefined): Promise<Date | undefined> {
  const executeRaw = vi.fn().mockResolvedValue(0);
  const { cron } = build({ executeRaw, days });
  await cron.pruneExpiredEvents();
  return cutoffOf(executeRaw.mock.calls[0]);
}

describe('EventLogRetentionCron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers().setSystemTime(new Date('2026-08-24T00:00:00.000Z'));
  });

  afterEach(() => vi.useRealTimers());

  it('prunes both the event log and the access buckets on one tick', async () => {
    const executeRaw = vi.fn().mockResolvedValue(3);
    const { cron } = build({ executeRaw });

    await cron.pruneExpiredEvents();

    expect(executeRaw.mock.calls.map(tableOf)).toEqual(['"EventLog"', '"EventLogAccessBucket"']);
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining('Purged 3 event log rows + 3 access buckets'));
  });

  it('cuts at now minus the configured window when EVENT_LOG_RETENTION_DAYS is a positive integer', async () => {
    await expect(cutoffFor('30')).resolves.toEqual(new Date(Date.now() - 30 * DAY_MS));
    await expect(cutoffFor('1')).resolves.toEqual(new Date(Date.now() - DAY_MS));
  });

  it.each([undefined, '', '1.5', '30days', '0', '-5', ' 30', '30 ', '+30', '0x1e', 'nonsense', 'Infinity'])(
    'falls back to the default window rather than coercing EVENT_LOG_RETENTION_DAYS=%o',
    async (days) => {
      await expect(cutoffFor(days)).resolves.toEqual(new Date(Date.now() - DEFAULT_RETENTION_DAYS * DAY_MS));
    },
  );

  it('issues exactly one batch per table when the first batch is short', async () => {
    const executeRaw = vi.fn().mockResolvedValue(0);
    const { cron, eventLogCount, bucketCount } = build({ executeRaw });

    await cron.pruneExpiredEvents();

    expect(executeRaw).toHaveBeenCalledTimes(2);
    expect(eventLogCount).not.toHaveBeenCalled();
    expect(bucketCount).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('keeps batching while batches come back full and stops on the first short batch', async () => {
    const executeRaw = vi
      .fn()
      .mockResolvedValueOnce(BATCH_SIZE)
      .mockResolvedValueOnce(BATCH_SIZE)
      .mockResolvedValueOnce(BATCH_SIZE - 1)
      .mockResolvedValue(0);
    const { cron } = build({ executeRaw });

    await cron.pruneExpiredEvents();

    expect(executeRaw.mock.calls.map(tableOf)).toEqual([
      '"EventLog"',
      '"EventLog"',
      '"EventLog"',
      '"EventLogAccessBucket"',
    ]);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining(`Purged ${BATCH_SIZE * 3 - 1} event log rows + 0 access buckets`),
    );
  });

  it('stops each table at its own batch cap when every batch stays full', async () => {
    const executeRaw = vi.fn().mockResolvedValue(BATCH_SIZE);
    const { cron } = build({ executeRaw });

    await cron.pruneExpiredEvents();

    const perTable = executeRaw.mock.calls.map(tableOf);
    expect(perTable.filter((table) => table === '"EventLog"')).toHaveLength(MAX_BATCHES_PER_TABLE);
    expect(perTable.filter((table) => table === '"EventLogAccessBucket"')).toHaveLength(MAX_BATCHES_PER_TABLE);
  });

  it('warns with the rows still over the window once the cap is hit', async () => {
    const executeRaw = vi.fn().mockResolvedValue(BATCH_SIZE);
    const { cron, eventLogCount, bucketCount } = build({ executeRaw, eventLogRemaining: 42, bucketRemaining: 7 });

    await cron.pruneExpiredEvents();

    expect(eventLogCount).toHaveBeenCalledTimes(1);
    expect(bucketCount).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('42 event log rows + 7 access buckets remain older than 365 days'),
    );
  });

  it('stays silent about a backlog when the cap was never reached', async () => {
    const executeRaw = vi.fn().mockResolvedValue(1);
    const { cron } = build({ executeRaw, eventLogRemaining: 42 });

    await cron.pruneExpiredEvents();

    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs the failure instead of throwing when a batch delete rejects', async () => {
    const executeRaw = vi.fn().mockRejectedValue(new Error('deadlock detected'));
    const { cron } = build({ executeRaw });

    await expect(cron.pruneExpiredEvents()).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith('Event log retention cleanup failed: deadlock detected');
  });
});

describe('resolveRetentionDays', () => {
  const resolve = (days: string | undefined): number =>
    resolveRetentionDays({ get: vi.fn().mockReturnValue(days) } as unknown as ConfigService);

  it.each([
    ['30', 30],
    ['1', 1],
    ['365', 365],
    ['4000', 4000],
  ])('returns the configured window for EVENT_LOG_RETENTION_DAYS=%o', (days, expected) => {
    expect(resolve(days)).toBe(expected);
  });

  it.each([
    undefined,
    '',
    '1.5',
    '0.5',
    '30days',
    '0',
    '00',
    '-5',
    ' 30',
    '30 ',
    '+30',
    '0x1e',
    'nonsense',
    'Infinity',
  ])('returns the default rather than coercing EVENT_LOG_RETENTION_DAYS=%o', (days) => {
    expect(resolve(days)).toBe(DEFAULT_RETENTION_DAYS);
  });

  it('reads the window from EVENT_LOG_RETENTION_DAYS', () => {
    const configService = { get: vi.fn().mockReturnValue('30') };

    resolveRetentionDays(configService as unknown as ConfigService);

    expect(configService.get).toHaveBeenCalledWith('EVENT_LOG_RETENTION_DAYS');
  });
});
