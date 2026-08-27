import { ForbiddenException } from '@nestjs/common';
import { EVENT_LOG_CSV_COLUMNS, EventLogEntrySchema, contract, type EventLogEntry } from '@repo/api-client';
import { describe, expect, it, vi } from 'vitest';
import { encodeCursor, cursorAt } from '../event-log-cursor';
import {
  CSV_ROW_LIMIT,
  CSV_TRAILER_PREFIX,
  EventLogExportService,
  LOOKBACK_MS,
  type EventLogExportSink,
} from '../event-log-export.service';
import { EventLogRepository } from '../event-log.repository';
import { EventLogService } from '../event-log.service';

const ORGANIZATION_ID = 'org-under-test';

function entry(overrides: Partial<EventLogEntry> = {}): EventLogEntry {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tier: 'EVIDENCE',
    durability: 'ATOMIC',
    resource: 'member',
    action: 'removed',
    actionKey: 'member.removed',
    actorType: 'UI',
    actorId: 'u-1',
    actorLabel: 'admin@example.com',
    apiKeyId: null,
    apiKeyLabel: null,
    targetId: 'm-1',
    targetLabel: 'member@example.com',
    outcome: 'SUCCEEDED',
    errorCode: null,
    requestId: 'req-1',
    method: 'DELETE',
    path: '/api/v1/organizations/members/m-1',
    ipAddress: '203.0.113.9',
    userAgent: 'vitest',
    metadata: null,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    ...overrides,
  };
}

function fakeSink(options: { backpressuredWrites?: number; destroyAfterWrites?: number } = {}) {
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  let backpressured = options.backpressuredWrites ?? 0;
  let destroyed = false;
  const sink = {
    get headersSent() {
      return chunks.length > 0;
    },
    get destroyed() {
      return destroyed;
    },
    status: vi.fn(),
    setHeader: vi.fn((name: string, value: string) => (headers[name] = value)),
    json: vi.fn(),
    write: vi.fn((chunk: string) => {
      chunks.push(chunk);
      if (destroyed) return false;
      if (backpressured > 0) {
        backpressured -= 1;
        return false;
      }
      if (options.destroyAfterWrites !== undefined && chunks.length >= options.destroyAfterWrites) destroyed = true;
      return true;
    }),
    drain: vi.fn(() => (destroyed ? new Promise<void>(() => {}) : Promise.resolve())),
    end: vi.fn(),
    destroy: vi.fn(() => {
      destroyed = true;
    }),
  } satisfies EventLogExportSink;

  return { sink, chunks, headers, body: () => chunks.join('') };
}

function build(
  repository: Partial<EventLogRepository>,
  options: { permissions?: string[]; retentionDays?: string } = {},
) {
  const recordExport = vi.fn().mockResolvedValue(undefined);
  const logger = { log: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn(), verbose: vi.fn() };
  const granted = options.permissions ?? ['event-log:access'];
  const contextService = {
    requirePermission: vi.fn((resource: string, action: string) => {
      if (!granted.includes(`${resource}:${action}`)) {
        throw new ForbiddenException(`Missing permission ${resource}:${action}`);
      }
      return undefined;
    }),
    organizationId: ORGANIZATION_ID,
  };
  const configService = { get: vi.fn(() => options.retentionDays) };

  const service = new EventLogExportService(
    repository as EventLogRepository,
    { recordExport } as unknown as EventLogService,
    contextService as never,
    configService as never,
    logger as never,
  );

  return { service, recordExport, logger, contextService };
}

function csvRepository(rows: EventLogEntry[], matching = rows.length) {
  return {
    countAfterKey: vi.fn().mockResolvedValue(matching),
    findAfterKey: vi.fn().mockResolvedValueOnce(rows).mockResolvedValue([]),
  };
}

describe('event-log export contract', () => {
  it('declares the guard and cursor-expiry responses the route can actually produce', () => {
    expect(Object.keys(contract.exportEventLog.responses).sort()).toEqual(['200', '401', '403', '409']);
  });

  it('states in its description that the csv columns are the api projection', () => {
    expect(contract.exportEventLog.description).toContain('exactly the fields of the JSON entry projection');
  });

  it('scopes the declared 200 body to the json format and names the csv content type', () => {
    expect(contract.exportEventLog.description).toContain('describes format=json only');
    expect(contract.exportEventLog.description).toContain('text/csv; charset=utf-8');
  });
});

describe('event-log export CSV columns', () => {
  it('exports every field of the api entry projection and nothing else', () => {
    expect([...EVENT_LOG_CSV_COLUMNS].sort()).toEqual([...EventLogEntrySchema.keyof().options].sort());
  });

  it('writes a header row of exactly the projection keys in the documented order', async () => {
    const { service } = build(csvRepository([]));
    const { sink, chunks } = fakeSink();

    await service.export({ format: 'csv' }, sink);

    expect(chunks[0]).toBe(`${EVENT_LOG_CSV_COLUMNS.map((column) => `"${column}"`).join(',')}\n`);
  });

  it('serializes createdAt as ISO 8601 and metadata as one json column', async () => {
    const row = entry({ metadata: { grantedKeys: ['device:read'] } });
    const { service } = build(csvRepository([row]));
    const { sink, body } = fakeSink();

    await service.export({ format: 'csv' }, sink);

    expect(body()).toContain('"2026-08-01T10:00:00.000Z"');
    expect(body()).toContain('"{""grantedKeys"":[""device:read""]}"');
  });
});

describe('event-log export CSV truncation', () => {
  it('does not report exactly the row limit as truncated', async () => {
    const { service } = build(csvRepository([entry()], CSV_ROW_LIMIT));
    const { sink, headers, body } = fakeSink();

    await service.export({ format: 'csv' }, sink);

    expect(headers['X-Event-Log-Truncated']).toBe('false');
    expect(body()).toContain(`${CSV_TRAILER_PREFIX} rows=1 truncated=false limit=${CSV_ROW_LIMIT}`);
  });

  it('reports one row past the limit as truncated', async () => {
    const { service } = build(csvRepository([entry()], CSV_ROW_LIMIT + 1));
    const { sink, headers, body } = fakeSink();

    await service.export({ format: 'csv' }, sink);

    expect(headers['X-Event-Log-Truncated']).toBe('true');
    expect(body()).toContain(`truncated=true limit=${CSV_ROW_LIMIT}`);
  });

  it('probes one row past the limit so the extra row decides truncation', async () => {
    const repository = csvRepository([], CSV_ROW_LIMIT);
    const { service } = build(repository);
    const { sink } = fakeSink();

    await service.export({ format: 'csv' }, sink);

    expect(repository.countAfterKey.mock.calls[0][2]).toBe(CSV_ROW_LIMIT + 1);
  });
});

describe('event-log export CSV backpressure', () => {
  it('awaits a drain when a write is backpressured and still finishes the file', async () => {
    const { service } = build(csvRepository([entry(), entry()]));
    const { sink, body } = fakeSink({ backpressuredWrites: 1 });

    await service.export({ format: 'csv' }, sink);

    expect(sink.drain).toHaveBeenCalledTimes(1);
    expect(body()).toContain(`${CSV_TRAILER_PREFIX} rows=2 truncated=false`);
    expect(sink.end).toHaveBeenCalled();
  });

  it('skips the trailer instead of waiting on a drain that a disconnected client will never send', async () => {
    const repository = {
      countAfterKey: vi.fn().mockResolvedValue(3),
      findAfterKey: vi.fn().mockResolvedValue([entry(), entry()]),
    };
    const { service } = build(repository);
    const { sink, body } = fakeSink({ destroyAfterWrites: 2 });

    await service.export({ format: 'csv' }, sink);

    expect(sink.destroyed).toBe(true);
    expect(body()).not.toContain('rows=');
    expect(sink.drain).not.toHaveBeenCalled();
  });
});

describe('event-log export access logging', () => {
  it('records an export for every csv call', async () => {
    const { service, recordExport } = build(csvRepository([entry()]));

    await service.export({ format: 'csv' }, fakeSink().sink);
    await service.export({ format: 'csv' }, fakeSink().sink);

    expect(recordExport).toHaveBeenCalledTimes(2);
  });

  it('records nothing for a json pull, which reads the log rather than exporting it', async () => {
    const { service, recordExport } = build({ findAfterKey: vi.fn().mockResolvedValue([entry()]) });

    await service.export({ format: 'json' }, fakeSink().sink);

    expect(recordExport).not.toHaveBeenCalled();
  });

  it('does not record an export when the caller lacks event-log access', async () => {
    const { service, recordExport } = build(csvRepository([entry()]), { permissions: [] });
    const { sink } = fakeSink();

    await service.export({ format: 'csv' }, sink);

    expect(recordExport).not.toHaveBeenCalled();
    expect(sink.status).toHaveBeenCalledWith(403);
  });
});

describe('event-log export failure handling', () => {
  it('answers a pre-stream failure with a status instead of an empty file', async () => {
    const repository = { countAfterKey: vi.fn().mockRejectedValue(new Error('database is down')) };
    const { service } = build(repository);
    const { sink } = fakeSink();

    await service.export({ format: 'csv' }, sink);

    expect(sink.status).toHaveBeenCalledWith(500);
    expect(sink.json).toHaveBeenCalledWith({ statusCode: 500, message: 'Event log export failed' });
    expect(sink.write).not.toHaveBeenCalled();
  });

  it('never leaks an internal failure message to the client', async () => {
    const repository = { countAfterKey: vi.fn().mockRejectedValue(new Error('password authentication failed')) };
    const { service } = build(repository);
    const { sink } = fakeSink();

    await service.export({ format: 'csv' }, sink);

    expect(JSON.stringify(sink.json.mock.calls)).not.toContain('password');
  });

  it('marks a mid-stream failure and aborts rather than ending a partial file cleanly', async () => {
    const repository = {
      countAfterKey: vi.fn().mockResolvedValue(3),
      findAfterKey: vi
        .fn()
        .mockResolvedValueOnce([entry(), entry()])
        .mockRejectedValue(new Error('connection reset mid-scan')),
    };
    const { service, logger } = build(repository);
    const { sink, chunks } = fakeSink();

    await service.export({ format: 'csv' }, sink);

    expect(chunks.at(-1)).toBe(`${CSV_TRAILER_PREFIX} error=stream-failed rows=2\n`);
    expect(sink.destroy).toHaveBeenCalled();
    expect(sink.end).not.toHaveBeenCalled();
    expect(chunks.join('')).not.toContain('truncated=');
    expect(logger.error).toHaveBeenCalled();
  });

  it('rejects a malformed cursor with a bad request', async () => {
    const { service } = build({ findAfterKey: vi.fn() });
    const { sink } = fakeSink();

    await service.export({ format: 'json', cursor: 'not-a-cursor' }, sink);

    expect(sink.status).toHaveBeenCalledWith(400);
  });
});

describe('event-log export cursor expiry', () => {
  const staleCursor = encodeCursor(cursorAt(new Date('2020-01-01T00:00:00.000Z')));

  it('answers a cursor older than the retention floor with the oldest available key', async () => {
    const oldest = { createdAt: new Date('2026-07-01T00:00:00.000Z'), id: 'oldest-id' };
    const { service } = build({ findOldestKey: vi.fn().mockResolvedValue(oldest), findAfterKey: vi.fn() });
    const { sink } = fakeSink();

    await service.export({ format: 'json', cursor: staleCursor }, sink);

    expect(sink.status).toHaveBeenCalledWith(409);
    expect(sink.json.mock.calls[0][0]).toMatchObject({
      statusCode: 409,
      error: 'cursor_expired',
      oldestAvailable: oldest,
    });
  });

  it('hands back a replacement cursor that reaches the oldest retained event', async () => {
    const oldest = { createdAt: new Date('2026-07-01T00:00:00.000Z'), id: 'oldest-id' };
    const { service } = build({ findOldestKey: vi.fn().mockResolvedValue(oldest), findAfterKey: vi.fn() });
    const { sink } = fakeSink();

    await service.export({ format: 'json', cursor: staleCursor }, sink);

    expect(sink.json.mock.calls[0][0].cursor).toBe(encodeCursor(cursorAt(oldest.createdAt)));
  });

  it('reports a null oldest key when the organization has no events left', async () => {
    const { service } = build({ findOldestKey: vi.fn().mockResolvedValue(null), findAfterKey: vi.fn() });
    const { sink } = fakeSink();

    await service.export({ format: 'json', cursor: staleCursor }, sink);

    expect(sink.json.mock.calls[0][0].oldestAvailable).toBeNull();
  });

  it('honours a configured retention window shorter than the default', async () => {
    const withinDefault = encodeCursor(cursorAt(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)));
    const { service } = build(
      { findOldestKey: vi.fn().mockResolvedValue(null), findAfterKey: vi.fn().mockResolvedValue([]) },
      { retentionDays: '7' },
    );
    const { sink } = fakeSink();

    await service.export({ format: 'json', cursor: withinDefault }, sink);

    expect(sink.status).toHaveBeenCalledWith(409);
  });
});

describe('event-log export tenant scoping', () => {
  it('pins the organization from context and ignores one supplied in the query', async () => {
    const repository = { findAfterKey: vi.fn().mockResolvedValue([]) };
    const { service } = build(repository);

    await service.export({ format: 'json', organizationId: 'someone-elses-org' }, fakeSink().sink);

    expect(repository.findAfterKey.mock.calls[0][0]).toMatchObject({ organizationId: ORGANIZATION_ID });
  });

  it('pins the organization on the csv path too', async () => {
    const repository = csvRepository([]);
    const { service } = build(repository);

    await service.export({ format: 'csv', organizationId: 'someone-elses-org' }, fakeSink().sink);

    expect(repository.countAfterKey.mock.calls[0][0]).toMatchObject({ organizationId: ORGANIZATION_ID });
    expect(repository.findAfterKey.mock.calls[0][0]).toMatchObject({ organizationId: ORGANIZATION_ID });
  });

  it('gates on event-log access before touching the query', async () => {
    const repository = { findAfterKey: vi.fn() };
    const { service, contextService } = build(repository, { permissions: [] });

    await service.export({ format: 'json' }, fakeSink().sink);

    expect(contextService.requirePermission).toHaveBeenCalledWith('event-log', 'access');
    expect(repository.findAfterKey).not.toHaveBeenCalled();
  });
});

describe('event-log export json paging', () => {
  it('starts a fresh pull one lookback behind now', async () => {
    const repository = { findAfterKey: vi.fn().mockResolvedValue([]) };
    const { service } = build(repository);
    const before = Date.now();

    await service.export({ format: 'json' }, fakeSink().sink);

    const scanAfter = repository.findAfterKey.mock.calls[0][1];
    expect(scanAfter.createdAt.getTime()).toBeGreaterThanOrEqual(before - LOOKBACK_MS);
    expect(scanAfter.createdAt.getTime()).toBeLessThanOrEqual(Date.now() - LOOKBACK_MS);
  });

  it('starts at an explicit from bound so a consumer can reach history', async () => {
    const repository = { findAfterKey: vi.fn().mockResolvedValue([]) };
    const { service } = build(repository);
    const from = new Date('2026-01-01T00:00:00.000Z');

    await service.export({ format: 'json', from: from.toISOString() }, fakeSink().sink);

    expect(repository.findAfterKey.mock.calls[0][1]).toEqual({ createdAt: from, id: '' });
  });

  it('reports more work when the page filled its limit', async () => {
    const repository = { findAfterKey: vi.fn().mockResolvedValue([entry(), entry()]) };
    const { service } = build(repository);
    const { sink } = fakeSink();

    await service.export({ format: 'json', pageSize: '2' }, sink);

    expect(sink.json.mock.calls[0][0].hasMore).toBe(true);
  });

  it('reports no more work and still returns a cursor on a short page', async () => {
    const repository = { findAfterKey: vi.fn().mockResolvedValue([entry()]) };
    const { service } = build(repository);
    const { sink } = fakeSink();

    await service.export({ format: 'json', pageSize: '2' }, sink);

    expect(sink.json.mock.calls[0][0].hasMore).toBe(false);
    expect(sink.json.mock.calls[0][0].cursor).toEqual(expect.any(String));
  });
});
