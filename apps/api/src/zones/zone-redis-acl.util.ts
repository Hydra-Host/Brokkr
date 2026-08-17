import { createHash, randomInt } from 'node:crypto';

export const REDIS_ACL_MANAGEMENT_FLAG = 'REDIS_ACL_MANAGEMENT_ENABLED';

export const ZONE_ACL_USERNAME_PREFIX = 'brokkr-spoke-';

export const zoneAclUsername = (zoneId: string): string => `${ZONE_ACL_USERNAME_PREFIX}${zoneId}`;

/** Both the rotate and zone-delete call sites MUST use this — the advisory lock only serializes byte-identical keys. */
export const zoneAclLockKey = (zoneId: string): string => `zone_redis_acl:${zoneId}`;

export function zoneIdFromAclUsername(username: string): string | null {
  return username.startsWith(ZONE_ACL_USERNAME_PREFIX) ? username.slice(ZONE_ACL_USERNAME_PREFIX.length) : null;
}

export function zoneAclSetUserArgs(zoneId: string, passwordSha256Hex: string): string[] {
  return [
    'SETUSER',
    zoneAclUsername(zoneId),
    'reset',
    'on',
    `#${passwordSha256Hex}`,
    `~${zoneId}:*`,
    '~results:*',
    `&${zoneId}:*`,
    '&results:*',
    '+@all',
    '-@admin',
    '-@dangerous',
    '+keys',
    '+info',
  ];
}

const PASSWORD_LENGTH = 24;
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const NUMERIC = '0123456789';
const SPECIAL = '!#$&*+-=?_~';
const ALL = LOWER + UPPER + NUMERIC + SPECIAL;

function pick(charset: string, count: number): string[] {
  return Array.from({ length: count }, () => charset[randomInt(charset.length)]);
}

export function generateZoneAclPassword(): string {
  const chars = [
    ...pick(LOWER, 7),
    ...pick(UPPER, 7),
    ...pick(NUMERIC, 7),
    ...pick(SPECIAL, 1),
    ...pick(ALL, PASSWORD_LENGTH - 22),
  ];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
