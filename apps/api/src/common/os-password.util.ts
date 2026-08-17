import { randomBytes } from 'node:crypto';

import { sha512 } from 'sha512-crypt-ts';

const SALT_ALPHABET = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SALT_LENGTH = 16;

function randomSalt(): string {
  const bytes = randomBytes(SALT_LENGTH);
  let salt = '';
  for (let i = 0; i < SALT_LENGTH; i++) {
    salt += SALT_ALPHABET[bytes[i] & 0x3f];
  }
  return salt;
}

export function hashOsPassword(plaintext: string, salt: string = randomSalt()): string {
  const hash = sha512.crypt(plaintext, salt);
  if (!hash.startsWith('$6$')) {
    throw new Error('Failed to produce a SHA-512 crypt hash for the OS password');
  }
  return hash;
}
