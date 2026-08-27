import { describe, expect, it } from 'vitest';
import {
  EVENT_LOG_CSV_COLUMNS,
  EventDurabilitySchema,
  EventLogCursorExpiredSchema,
  EventLogEntrySchema,
  EventLogExportPageSchema,
  EventLogExportQuerySchema,
} from '../event-log';

describe('EventDurabilitySchema', () => {
  it.each(['ATOMIC', 'POST_COMMIT', 'MIRROR', 'BEST_EFFORT'])('accepts %s', (value) => {
    expect(EventDurabilitySchema.parse(value)).toBe(value);
  });

  it('rejects a durability outside the enum', () => {
    expect(EventDurabilitySchema.safeParse('MIRRORED').success).toBe(false);
  });
});

describe('EventLogExportQuerySchema.format', () => {
  it('defaults to json when omitted', () => {
    expect(EventLogExportQuerySchema.parse({}).format).toBe('json');
  });

  it.each(['csv', 'json'])('accepts %s', (format) => {
    expect(EventLogExportQuerySchema.parse({ format }).format).toBe(format);
  });

  it.each(['xml', 'CSV', 'text/csv', ''])('rejects %s', (format) => {
    expect(EventLogExportQuerySchema.safeParse({ format }).success).toBe(false);
  });
});

describe('EventLogExportQuerySchema.pageSize', () => {
  it('defaults to the maximum when omitted', () => {
    expect(EventLogExportQuerySchema.parse({}).pageSize).toBe(1000);
  });

  it('coerces a numeric string, because query params arrive as strings', () => {
    expect(EventLogExportQuerySchema.parse({ pageSize: '250' }).pageSize).toBe(250);
  });

  it.each([1, 1000])('accepts the bound %s', (pageSize) => {
    expect(EventLogExportQuerySchema.parse({ pageSize }).pageSize).toBe(pageSize);
  });

  it.each([['zero', '0'], ['negative', '-1'], ['non-integer', '1.5'], ['above the maximum', '1001']])(
    'rejects %s',
    (_label, pageSize) => {
      expect(EventLogExportQuerySchema.safeParse({ pageSize }).success).toBe(false);
    },
  );
});

describe('EventLogExportQuerySchema filters', () => {
  it('carries the named audit filters through', () => {
    const parsed = EventLogExportQuerySchema.parse({
      actionKey: 'member.removed',
      resource: 'member',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      actorId: 'u-1',
      actorType: 'UI',
      outcome: 'SUCCEEDED',
      targetId: 'm-1',
    });

    expect(parsed).toMatchObject({
      actionKey: 'member.removed',
      resource: 'member',
      tier: 'EVIDENCE',
      durability: 'ATOMIC',
      actorId: 'u-1',
      actorType: 'UI',
      outcome: 'SUCCEEDED',
      targetId: 'm-1',
    });
  });

  it('coerces the createdAt window to dates', () => {
    const parsed = EventLogExportQuerySchema.parse({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' });

    expect(parsed.from).toEqual(new Date('2026-08-01T00:00:00.000Z'));
    expect(parsed.to).toEqual(new Date('2026-08-02T00:00:00.000Z'));
  });

  it('reads the string "false" as false rather than coercing it to true', () => {
    expect(EventLogExportQuerySchema.parse({ includeSystemActors: 'false' }).includeSystemActors).toBe(false);
    expect(EventLogExportQuerySchema.parse({ includeSystemActors: 'true' }).includeSystemActors).toBe(true);
  });

  it('does not accept the browse-only free-text search', () => {
    expect(Object.keys(EventLogExportQuerySchema.shape)).not.toContain('search');
  });

  it('does not accept an organization id from the caller', () => {
    expect(Object.keys(EventLogExportQuerySchema.shape)).not.toContain('organizationId');
  });

  it.each(['tier', 'durability', 'outcome', 'actorType'])('rejects an out-of-enum %s', (field) => {
    expect(EventLogExportQuerySchema.safeParse({ [field]: 'NOPE' }).success).toBe(false);
  });
});

describe('EventLogExportPageSchema', () => {
  const page = { data: [], cursor: 'opaque', hasMore: false };

  it('accepts an empty page that still carries a cursor', () => {
    expect(EventLogExportPageSchema.parse(page)).toEqual(page);
  });

  it.each(['cursor', 'hasMore', 'data'])('requires %s', (field) => {
    const { [field]: _omitted, ...rest } = page as Record<string, unknown>;
    expect(EventLogExportPageSchema.safeParse(rest).success).toBe(false);
  });

  it('validates the entries it carries', () => {
    expect(EventLogExportPageSchema.safeParse({ ...page, data: [{ id: 'not-a-uuid' }] }).success).toBe(false);
  });
});

describe('EventLogCursorExpiredSchema', () => {
  const expired = {
    statusCode: 409,
    error: 'cursor_expired',
    message: 'gone, not skipped',
    oldestAvailable: { createdAt: '2026-07-01T00:00:00.000Z', id: 'oldest' },
    cursor: 'replacement',
  };

  it('coerces the oldest available key timestamp', () => {
    expect(EventLogCursorExpiredSchema.parse(expired).oldestAvailable?.createdAt).toEqual(
      new Date('2026-07-01T00:00:00.000Z'),
    );
  });

  it('accepts a null oldest available key', () => {
    expect(EventLogCursorExpiredSchema.parse({ ...expired, oldestAvailable: null }).oldestAvailable).toBeNull();
  });

  it('pins the discriminator so a client can branch on it', () => {
    expect(EventLogCursorExpiredSchema.safeParse({ ...expired, error: 'something_else' }).success).toBe(false);
  });

  it('requires a replacement cursor', () => {
    const { cursor: _omitted, ...rest } = expired;
    expect(EventLogCursorExpiredSchema.safeParse(rest).success).toBe(false);
  });
});

describe('EVENT_LOG_CSV_COLUMNS', () => {
  it('is exactly the entry projection, so the two cannot drift', () => {
    expect([...EVENT_LOG_CSV_COLUMNS].sort()).toEqual([...EventLogEntrySchema.keyof().options].sort());
  });

  it('leads with the dedupe key and the sort key', () => {
    expect(EVENT_LOG_CSV_COLUMNS.slice(0, 2)).toEqual(['id', 'createdAt']);
  });

  it('names each column once', () => {
    expect(new Set(EVENT_LOG_CSV_COLUMNS).size).toBe(EVENT_LOG_CSV_COLUMNS.length);
  });
});
