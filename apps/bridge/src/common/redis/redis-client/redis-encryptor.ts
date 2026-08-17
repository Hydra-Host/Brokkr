// (key, nonce) must be unique in production — GCM nonce reuse is catastrophic; only tests may fix the nonce factory.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { RedisEncryptionError } from './redis.errors';

const NONCE_LEN = 12;
const TAG_LEN = 16;

export type NonceFactory = () => Buffer;

function decodeBase64Strict(s: string): Buffer {
  const stripped = s.replace(/[^A-Za-z0-9+/=]/g, '');
  const eqIdx = stripped.indexOf('=');
  const data = eqIdx === -1 ? stripped : stripped.slice(0, eqIdx);
  const dataLen = data.length;
  if (dataLen % 4 === 1) {
    throw new Error(
      `Invalid base64-encoded string: number of data characters (${dataLen}) cannot be 1 more than a multiple of 4`,
    );
  }
  if (dataLen % 4 !== 0 && stripped.length % 4 !== 0) {
    throw new Error('Incorrect padding');
  }
  return Buffer.from(data, 'base64');
}

export class RedisEncryptor {
  private readonly key: Buffer;
  private readonly nonceFactory: NonceFactory;

  constructor(keyB64: string, nonceFactory?: NonceFactory) {
    let keyBytes: Buffer;
    try {
      keyBytes = decodeBase64Strict(keyB64);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RedisEncryptionError(`Invalid BRIDGE_AT_REST_KEY: ${message}`);
    }
    if (keyBytes.length !== 32) {
      throw new RedisEncryptionError(`Invalid BRIDGE_AT_REST_KEY: Key must be 32 bytes, got ${keyBytes.length}`);
    }
    this.key = keyBytes;
    this.nonceFactory = nonceFactory ?? (() => randomBytes(NONCE_LEN));
  }

  encrypt(plaintext: string): string {
    const nonce = this.nonceFactory();
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce, { authTagLength: TAG_LEN });
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, ciphertext, tag]).toString('base64');
  }

  decrypt(envelopeB64: string): string {
    try {
      const raw = decodeBase64Strict(envelopeB64);
      if (raw.length < NONCE_LEN + TAG_LEN) {
        throw new Error('envelope too short');
      }
      const nonce = raw.subarray(0, NONCE_LEN);
      const ciphertext = raw.subarray(NONCE_LEN, raw.length - TAG_LEN);
      const tag = raw.subarray(raw.length - TAG_LEN);
      if (tag.length !== TAG_LEN) {
        throw new Error('tag has invalid length');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce, { authTagLength: TAG_LEN });
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plaintext.toString('utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new RedisEncryptionError(`Decryption failed: ${message}`);
    }
  }
}
