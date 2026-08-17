import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export interface CachedToken {
  token: string;
  hash: string;
}

export function readCachedToken(reuseFile: string | undefined): CachedToken | null {
  if (!reuseFile || !existsSync(reuseFile)) return null;
  const token = readFileSync(reuseFile, 'utf8').trim();
  if (!token) return null;
  return { token, hash: createHash('sha256').update(token, 'utf8').digest('hex') };
}

export interface RegistrationTokenRow {
  id: string;
  zoneId: string;
  consumedAt: Date | null;
  expiresAt: Date;
}

/** Must match the predicate the hub applies when accepting a token at /enroll. */
export function isReusableTokenRow(
  row: RegistrationTokenRow | null,
  zoneId: string,
  now: Date,
): row is RegistrationTokenRow {
  return row !== null && row.zoneId === zoneId && row.consumedAt === null && row.expiresAt > now;
}
