import { types } from 'pg';
import { describe, expect, it } from 'vitest';

import '../pg.service';

const parse = (raw: string) => types.getTypeParser(types.builtins.TIMESTAMP)(raw) as unknown as Date;

describe('the naive timestamp parser', () => {
  it('reads a naive column as the utc prisma wrote, not as the local zone', () => {
    const parsed = parse('2026-08-11 18:35:04.532');

    expect(parsed.toISOString()).toBe('2026-08-11T18:35:04.532Z');
  });

  it('gives the same instant whatever zone the process runs in', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Chicago';
      const chicago = parse('2026-08-11 18:35:04.532').getTime();
      process.env.TZ = 'Asia/Tokyo';
      const tokyo = parse('2026-08-11 18:35:04.532').getTime();

      expect(chicago).toBe(tokyo);
    } finally {
      process.env.TZ = original;
    }
  });

  it('does not report a stamp from a minute ago as being in the future', () => {
    const aMinuteAgo = new Date(Date.now() - 60_000);
    const naive = aMinuteAgo.toISOString().replace('T', ' ').replace('Z', '');

    expect(parse(naive).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('keeps sub-second precision, which the event timeline orders on', () => {
    expect(parse('2026-08-11 18:35:04.532').getMilliseconds()).toBe(532);
  });
});
