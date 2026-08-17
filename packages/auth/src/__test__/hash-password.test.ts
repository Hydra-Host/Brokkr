import { describe, expect, it } from 'vitest';

import { BCRYPT_MAX_PASSWORD_BYTES, comparePassword, hashPassword } from '../password';

describe('hashPassword byte-length enforcement', () => {
  it('hashes a password at exactly the byte limit', async () => {
    const password = 'a'.repeat(BCRYPT_MAX_PASSWORD_BYTES);
    expect(Buffer.byteLength(password, 'utf8')).toBe(BCRYPT_MAX_PASSWORD_BYTES);
    const hash = await hashPassword(password);
    expect(await comparePassword(password, hash)).toBe(true);
  });

  it('rejects an ASCII password over the byte limit', async () => {
    const password = 'a'.repeat(BCRYPT_MAX_PASSWORD_BYTES + 1);
    await expect(hashPassword(password)).rejects.toThrow();
  });

  it('rejects a multibyte password under 72 chars but over 72 bytes (bcrypt truncation gap)', async () => {
    const password = '密'.repeat(27);
    expect(password.length).toBeLessThanOrEqual(BCRYPT_MAX_PASSWORD_BYTES);
    expect(Buffer.byteLength(password, 'utf8')).toBeGreaterThan(BCRYPT_MAX_PASSWORD_BYTES);
    await expect(hashPassword(password)).rejects.toThrow();
  });

  it('allows a multibyte password within the byte limit', async () => {
    const password = '密'.repeat(24);
    expect(Buffer.byteLength(password, 'utf8')).toBe(BCRYPT_MAX_PASSWORD_BYTES);
    const hash = await hashPassword(password);
    expect(await comparePassword(password, hash)).toBe(true);
  });
});
