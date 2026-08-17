import { Buffer } from 'node:buffer';
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO = Buffer.from('brokkr-device-secret-reveal-stash-v1', 'utf8');

export function deriveStashKey(hubPriv: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', hubPriv, Buffer.alloc(0), HKDF_INFO, KEY_BYTES));
}

export function encryptStash(key: Buffer, plaintext: Buffer, requestId: string): string {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(requestId, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

export function decryptStash(key: Buffer, blob: string, requestId: string): Buffer {
  const raw = Buffer.from(blob, 'base64');
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(requestId, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
