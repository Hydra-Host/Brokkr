import { HttpException, HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertOrganizationNotDeleted, assertUserNotBanned } from '../identity-guards';

const HOUR_MS = 60 * 60 * 1000;
const past = () => new Date(Date.now() - HOUR_MS);
const future = () => new Date(Date.now() + HOUR_MS);

function sessionHookDeniesBan(user: { banned: boolean; banExpires: Date | null }): boolean {
  return Boolean(user.banned && (!user.banExpires || user.banExpires > new Date()));
}

function guardDeniesBan(user: { banned: boolean; banExpires: Date | null }): boolean {
  try {
    assertUserNotBanned(user);
    return false;
  } catch {
    return true;
  }
}

describe('assertUserNotBanned', () => {
  it('allows a user who is not banned', () => {
    expect(() => assertUserNotBanned({ banned: false, banExpires: null })).not.toThrow();
  });

  it('denies a banned user with no expiry (permanent ban)', () => {
    expect(() => assertUserNotBanned({ banned: true, banExpires: null })).toThrow(HttpException);
    try {
      assertUserNotBanned({ banned: true, banExpires: null });
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    }
  });

  it('allows a banned user whose ban has expired (lazy lift)', () => {
    expect(() => assertUserNotBanned({ banned: true, banExpires: past() })).not.toThrow();
  });

  it('denies a banned user whose ban expires in the future', () => {
    expect(() => assertUserNotBanned({ banned: true, banExpires: future() })).toThrow(HttpException);
  });
});

describe('assertOrganizationNotDeleted', () => {
  it('allows an organization that is not deleted', () => {
    expect(() => assertOrganizationNotDeleted({ deletedAt: null })).not.toThrow();
  });

  it('denies a deleted organization with 403', () => {
    expect(() => assertOrganizationNotDeleted({ deletedAt: new Date() })).toThrow(HttpException);
    try {
      assertOrganizationNotDeleted({ deletedAt: new Date() });
    } catch (error) {
      expect((error as HttpException).getStatus()).toBe(HttpStatus.FORBIDDEN);
    }
  });
});

describe('ban-rule parity: guard helper vs session-create hook', () => {
  const cases = [
    { name: 'not banned', user: { banned: false, banExpires: null } },
    { name: 'permanent ban', user: { banned: true, banExpires: null } },
    { name: 'expired ban', user: { banned: true, banExpires: past() } },
    { name: 'active ban', user: { banned: true, banExpires: future() } },
  ];

  it.each(cases)('agrees on the deny decision for $name', ({ user }) => {
    expect(guardDeniesBan(user)).toBe(sessionHookDeniesBan(user));
  });
});
