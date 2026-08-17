import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import { RedisEncryptor } from '../redis-encryptor';
import { RedisEncryptionError } from '../redis.errors';

const NONCE_LEN = 12;
const TAG_LEN = 16;
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');

describe('RedisEncryptor', () => {
  it('round-trips a valid envelope', () => {
    const enc = new RedisEncryptor(KEY_B64);
    const plaintext = 'the quick brown fox';
    const recovered = enc.decrypt(enc.encrypt(plaintext));
    expect(recovered).toBe(plaintext);
  });

  it('produces an envelope with a full 16-byte tag', () => {
    const enc = new RedisEncryptor(KEY_B64);
    const raw = Buffer.from(enc.encrypt('payload'), 'base64');
    expect(raw.length).toBeGreaterThanOrEqual(NONCE_LEN + TAG_LEN);
  });

  it.each([4, 8, 12])('rejects a tail truncated by %d bytes from the tag', (chop) => {
    const enc = new RedisEncryptor(KEY_B64);
    const raw = Buffer.from(enc.encrypt('payload'), 'base64');
    const truncated = raw.subarray(0, raw.length - chop).toString('base64');
    expect(() => enc.decrypt(truncated)).toThrow(RedisEncryptionError);
  });

  it('rejects an envelope shorter than nonce + tag', () => {
    const enc = new RedisEncryptor(KEY_B64);
    const tooShort = Buffer.alloc(NONCE_LEN + TAG_LEN - 1).toString('base64');
    expect(() => enc.decrypt(tooShort)).toThrow(RedisEncryptionError);
  });

  it('rejects a tampered tag', () => {
    const enc = new RedisEncryptor(KEY_B64);
    const raw = Buffer.from(enc.encrypt('payload'), 'base64');
    raw[raw.length - 1] ^= 0xff;
    expect(() => enc.decrypt(raw.toString('base64'))).toThrow(RedisEncryptionError);
  });
});
