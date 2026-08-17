import { createHmac, randomBytes } from 'crypto';

const BASE32URL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const RANDOM_TOKEN_BYTES = 32;

export function generateDeviceTokenPlaintext(): string {
  return base32UrlEncode(randomBytes(RANDOM_TOKEN_BYTES));
}

// Pepper is the HMAC key: rotating it changes every hash, so previously-issued tokens no longer match and devices must re-provision.
export function hashDeviceToken(plaintext: string, pepper: string): string {
  return createHmac('sha256', pepper).update(plaintext, 'utf8').digest('hex');
}

export function displayIdFromHash(tokenHash: string): string {
  return `dtok_${tokenHash.slice(0, 12)}`;
}

function base32UrlEncode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32URL_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32URL_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}
