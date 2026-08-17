import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { isReusableTokenRow, readCachedToken } from '../mint-sim-registration-token.helpers';

describe('mint-sim-registration-token helpers', () => {
  describe('readCachedToken', () => {
    let dir: string;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'mint-reuse-'));
    });
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('returns null when no path is given (first ever mint → mint fresh)', () => {
      expect(readCachedToken(undefined)).toBeNull();
    });

    it('returns null when the file does not exist', () => {
      expect(readCachedToken(join(dir, 'nope.token'))).toBeNull();
    });

    it('returns null when the file is empty or whitespace-only', () => {
      const p = join(dir, 'empty.token');
      writeFileSync(p, '   \n');
      expect(readCachedToken(p)).toBeNull();
    });

    it('returns the trimmed token and its sha256 hex hash', () => {
      const p = join(dir, 'tok.token');
      writeFileSync(p, 'abc\n');
      expect(readCachedToken(p)).toEqual({
        token: 'abc',
        hash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      });
    });
  });

  describe('isReusableTokenRow', () => {
    const now = new Date('2026-06-26T12:00:00Z');
    const zoneId = '00000000-0000-0000-0000-111111111111';
    const future = new Date('2026-06-27T12:00:00Z');
    const past = new Date('2026-06-26T11:59:59Z');
    const liveRow = { id: 't1', zoneId, consumedAt: null, expiresAt: future };

    it('reusable when unconsumed, unexpired, and same zone', () => {
      expect(isReusableTokenRow(liveRow, zoneId, now)).toBe(true);
    });

    it('not reusable when the row is missing (file stale / fresh DB → mint fresh)', () => {
      expect(isReusableTokenRow(null, zoneId, now)).toBe(false);
    });

    it('not reusable when the token belongs to a different zone', () => {
      expect(isReusableTokenRow({ ...liveRow, zoneId: 'other-zone' }, zoneId, now)).toBe(false);
    });

    it('not reusable once consumed — re-emitting a spent token would fail enroll', () => {
      expect(isReusableTokenRow({ ...liveRow, consumedAt: past }, zoneId, now)).toBe(false);
    });

    it('not reusable when expired, including the exact boundary (hub treats expiresAt<=now as 410)', () => {
      expect(isReusableTokenRow({ ...liveRow, expiresAt: past }, zoneId, now)).toBe(false);
      expect(isReusableTokenRow({ ...liveRow, expiresAt: now }, zoneId, now)).toBe(false);
    });
  });
});
