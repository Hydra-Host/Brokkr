import { Prisma } from '@repo/database';
import { describe, expect, it } from 'vitest';
import { generateZoneId, isUuidSuffixConflict } from '../zone-uuid';

function p2002(target: string | string[] | undefined) {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
    code: 'P2002',
    clientVersion: 'test',
    meta: target === undefined ? {} : { target },
  });
}

describe('generateZoneId', () => {
  it('returns a uuid whose last 5 chars are the uuidSuffix', () => {
    const { id, uuidSuffix } = generateZoneId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(uuidSuffix).toHaveLength(5);
    expect(uuidSuffix).toBe(id.slice(-5));
  });

  it('produces distinct ids across calls', () => {
    expect(generateZoneId().id).not.toBe(generateZoneId().id);
  });
});

describe('isUuidSuffixConflict', () => {
  it('true for a P2002 whose target array includes uuidSuffix', () => {
    expect(isUuidSuffixConflict(p2002(['uuidSuffix']))).toBe(true);
  });

  it('true for a P2002 whose target is a string mentioning uuidSuffix', () => {
    expect(isUuidSuffixConflict(p2002('Zone_uuidSuffix_key'))).toBe(true);
  });

  it('false for a P2002 on a different column (must not be retried)', () => {
    expect(isUuidSuffixConflict(p2002(['name']))).toBe(false);
  });

  it('false for a P2002 with no target', () => {
    expect(isUuidSuffixConflict(p2002(undefined))).toBe(false);
  });

  it('false for a non-P2002 Prisma error', () => {
    expect(
      isUuidSuffixConflict(new Prisma.PrismaClientKnownRequestError('missing', { code: 'P2025', clientVersion: 't' })),
    ).toBe(false);
  });

  it('false for a plain Error', () => {
    expect(isUuidSuffixConflict(new Error('boom'))).toBe(false);
  });
});
