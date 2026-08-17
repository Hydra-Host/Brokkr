import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { decryptStash, deriveStashKey, encryptStash } from '../reveal-stash.crypto';

const hubPriv = randomBytes(32);
const key = deriveStashKey(hubPriv);
const requestId = 'req-1234';
const plaintext = Buffer.from(JSON.stringify({ user: 'admin', pass: 'admin' }), 'utf8');

describe('reveal-stash AEAD', () => {
  it('round-trips a stash blob bound to its requestId', () => {
    const blob = encryptStash(key, plaintext, requestId);
    expect(decryptStash(key, blob, requestId).equals(plaintext)).toBe(true);
  });

  it('does not leak plaintext into the blob', () => {
    const blob = encryptStash(key, plaintext, requestId);
    expect(Buffer.from(blob, 'base64').toString('utf8')).not.toContain('admin');
  });

  it('rejects a blob opened under a different requestId (AAD binding)', () => {
    const blob = encryptStash(key, plaintext, requestId);
    expect(() => decryptStash(key, blob, 'req-other')).toThrow();
  });

  it('rejects a tampered blob (GCM tag failure)', () => {
    const raw = Buffer.from(encryptStash(key, plaintext, requestId), 'base64');
    raw[raw.length - 1] ^= 0x01;
    expect(() => decryptStash(key, raw.toString('base64'), requestId)).toThrow();
  });

  it('rejects a blob opened with a key derived from a different hub private key', () => {
    const blob = encryptStash(key, plaintext, requestId);
    const otherKey = deriveStashKey(randomBytes(32));
    expect(() => decryptStash(otherKey, blob, requestId)).toThrow();
  });

  it('derives the key deterministically from the hub private key', () => {
    expect(deriveStashKey(hubPriv).equals(key)).toBe(true);
  });
});
