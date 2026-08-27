import { describe, expect, it } from 'vitest';
import {
  advanceCursor,
  CursorFormatError,
  decodeCursor,
  encodeCursor,
  initialCursor,
  isCursorExpired,
  type CursorState,
  type EventKey,
} from '../event-log-cursor';

const HOUR = 60 * 60 * 1000;
const at = (time: string): Date => new Date(`2026-01-01T${time}.000Z`);
const key = (time: string, id: string): EventKey => ({ createdAt: at(time), id });
const floorKey = (time: string): EventKey => ({ createdAt: at(time), id: '' });
const base64url = (payload: unknown): string => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

const drainedCycle: CursorState = { replayFrom: floorKey('11:00:00'), scanAfter: key('12:30:00', 'evt-9') };

describe('event-log cursor encoding', () => {
  it('round-trips a cursor through encode and decode', () => {
    const state: CursorState = { replayFrom: key('11:00:00', 'evt-1'), scanAfter: key('11:45:30', 'evt-2') };

    expect(decodeCursor(encodeCursor(state))).toEqual(state);
  });

  it('carries a version marker in the encoded payload', () => {
    const encoded = encodeCursor(initialCursor(at('12:00:00'), HOUR));

    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toMatchObject({ v: 1 });
  });

  it('rejects a cursor that is not base64-encoded JSON', () => {
    expect(() => decodeCursor('not-a-cursor')).toThrow(CursorFormatError);
  });

  it('rejects a valid cursor with junk appended', () => {
    const encoded = encodeCursor(initialCursor(at('12:00:00'), HOUR));

    expect(() => decodeCursor(`${encoded}!`)).toThrow(CursorFormatError);
  });

  it('rejects a cursor with no version marker', () => {
    const raw = base64url({ replayFrom: { createdAt: at('11:00:00').toISOString(), id: '' }, scanAfter: null });

    expect(() => decodeCursor(raw)).toThrow(CursorFormatError);
  });

  it('rejects a cursor written by a different version', () => {
    const boundary = { createdAt: at('11:00:00').toISOString(), id: '' };

    expect(() => decodeCursor(base64url({ v: 2, replayFrom: boundary, scanAfter: boundary }))).toThrow(
      'Cursor is not a version 1 cursor',
    );
  });

  it('rejects a cursor whose timestamps are not ISO-8601', () => {
    const boundary = { createdAt: 'yesterday', id: '' };

    expect(() => decodeCursor(base64url({ v: 1, replayFrom: boundary, scanAfter: boundary }))).toThrow(
      CursorFormatError,
    );
  });

  it('does not blame the version when the version is right and a timestamp is not', () => {
    const boundary = { createdAt: 'yesterday', id: '' };

    expect(() => decodeCursor(base64url({ v: 1, replayFrom: boundary, scanAfter: boundary }))).toThrow(
      /replayFrom\.createdAt/,
    );
  });
});

describe('event-log cursor cycles', () => {
  it('starts a fresh consumer one lookback behind now', () => {
    expect(initialCursor(at('12:00:00'), HOUR)).toEqual({
      replayFrom: floorKey('11:00:00'),
      scanAfter: floorKey('11:00:00'),
    });
  });

  it('freezes replayFrom and advances scanAfter while pages come back full', () => {
    const next = advanceCursor(initialCursor(at('12:00:00'), HOUR), key('11:10:00', 'evt-1'), true, HOUR);

    expect(next).toEqual({ replayFrom: floorKey('11:00:00'), scanAfter: key('11:10:00', 'evt-1') });
  });

  it('reaches the last row of five consecutive full pages instead of oscillating', () => {
    const pages = [
      key('11:10:00', 'evt-1'),
      key('11:20:00', 'evt-2'),
      key('11:30:00', 'evt-3'),
      key('11:40:00', 'evt-4'),
      key('11:50:00', 'evt-5'),
    ];

    const drained = pages.reduce(
      (state, lastRow) => advanceCursor(state, lastRow, true, HOUR),
      initialCursor(at('12:00:00'), HOUR),
    );

    expect(drained).toEqual({ replayFrom: floorKey('11:00:00'), scanAfter: key('11:50:00', 'evt-5') });
  });

  it('starts a new cycle only when the page is short', () => {
    const lastRow = key('12:40:00', 'evt-10');

    expect(advanceCursor(drainedCycle, lastRow, true, HOUR)).toEqual({
      replayFrom: floorKey('11:00:00'),
      scanAfter: lastRow,
    });
    expect(advanceCursor(drainedCycle, lastRow, false, HOUR)).toEqual({
      replayFrom: floorKey('11:40:00'),
      scanAfter: floorKey('11:40:00'),
    });
  });

  it('restarts an empty page from the high-water mark minus the lookback', () => {
    expect(advanceCursor(drainedCycle, undefined, false, HOUR)).toEqual({
      replayFrom: floorKey('11:30:00'),
      scanAfter: floorKey('11:30:00'),
    });
  });

  it('never moves the replay floor behind where the previous cycle started', () => {
    const next = advanceCursor(drainedCycle, undefined, false, 4 * HOUR);

    expect(next.replayFrom).toEqual(drainedCycle.replayFrom);
    expect(next.scanAfter).toEqual(drainedCycle.scanAfter);
  });

  it('keeps the high-water mark rather than rewinding when a short page cannot move the floor', () => {
    const state: CursorState = { replayFrom: floorKey('11:00:00'), scanAfter: key('11:20:00', 'evt-2') };

    expect(advanceCursor(state, key('11:30:00', 'evt-3'), false, HOUR)).toEqual({
      replayFrom: floorKey('11:00:00'),
      scanAfter: key('11:30:00', 'evt-3'),
    });
  });

  it('stops replaying once an idle feed cannot move the floor again', () => {
    const restarted = advanceCursor(drainedCycle, undefined, false, HOUR);

    expect(advanceCursor(restarted, undefined, false, HOUR)).toEqual(restarted);
  });

  it('ignores a last row that sorts behind the high-water mark', () => {
    expect(advanceCursor(drainedCycle, key('11:05:00', 'evt-3'), true, HOUR)).toEqual(drainedCycle);
  });

  it('breaks a tied timestamp on the row id', () => {
    const state: CursorState = { replayFrom: floorKey('11:00:00'), scanAfter: key('11:20:00', 'evt-b') };

    expect(advanceCursor(state, key('11:20:00', 'evt-c'), true, HOUR).scanAfter).toEqual(key('11:20:00', 'evt-c'));
    expect(advanceCursor(state, key('11:20:00', 'evt-a'), true, HOUR).scanAfter).toEqual(key('11:20:00', 'evt-b'));
  });
});

describe('event-log cursor expiry', () => {
  it('expires a cursor whose replay floor predates the retention floor', () => {
    expect(isCursorExpired(initialCursor(at('12:00:00'), HOUR), at('11:30:00'))).toBe(true);
  });

  it('keeps a cursor whose replay floor is inside the retention window', () => {
    expect(isCursorExpired(initialCursor(at('12:00:00'), HOUR), at('10:30:00'))).toBe(false);
  });

  it('keeps a cursor sitting exactly on the retention floor', () => {
    expect(isCursorExpired(initialCursor(at('12:00:00'), HOUR), at('11:00:00'))).toBe(false);
  });
});
