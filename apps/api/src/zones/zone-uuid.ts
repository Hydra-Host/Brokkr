import { Prisma } from '@repo/database';
import { randomUUID } from 'node:crypto';

// Ids are generated app-side so the last 5 chars (Zone.uuidSuffix, used for device names) are unique; the DB unique index is the race-safe guarantee — callers regenerate on P2002.

export const MAX_UUID_SUFFIX_ATTEMPTS = 5;

export function generateZoneId(): { id: string; uuidSuffix: string } {
  const id = randomUUID();
  return { id, uuidSuffix: id.slice(-5) };
}

export function isUuidSuffixConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return false;
  const target = error.meta?.target;
  if (typeof target === 'string') return target.includes('uuidSuffix');
  if (Array.isArray(target)) return target.includes('uuidSuffix');
  return false;
}
