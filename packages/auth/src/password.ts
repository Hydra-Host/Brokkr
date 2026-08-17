import bcrypt from 'bcrypt';
import { APIError } from 'better-auth/api';

export const BCRYPT_MAX_PASSWORD_BYTES = 72;

// Cost factor 10 must match Better Auth's credential provider so seeded hashes verify identically.
export async function hashPassword(password: string): Promise<string> {
  if (Buffer.byteLength(password, 'utf8') > BCRYPT_MAX_PASSWORD_BYTES) {
    throw new APIError('BAD_REQUEST', {
      message: `Password must be at most ${BCRYPT_MAX_PASSWORD_BYTES} bytes (UTF-8) long.`,
    });
  }
  return bcrypt.hash(password, 10);
}

export async function comparePassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
