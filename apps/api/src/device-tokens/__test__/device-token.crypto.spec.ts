import { describe, expect, it } from 'vitest';
import { displayIdFromHash, generateDeviceTokenPlaintext, hashDeviceToken } from '../device-token.crypto';

describe('device token crypto', () => {
  it('hashes tokens with deterministic HMAC-SHA256', () => {
    const hash = hashDeviceToken('some-opaque-token', 'pepper-one');

    expect(hash).toBe(hashDeviceToken('some-opaque-token', 'pepper-one'));
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the token hash when the pepper changes', () => {
    expect(hashDeviceToken('some-opaque-token', 'pepper-one')).not.toBe(
      hashDeviceToken('some-opaque-token', 'pepper-two'),
    );
  });

  it('generates opaque base32url plaintext tokens', () => {
    const token = generateDeviceTokenPlaintext();

    expect(token).toMatch(/^[a-z2-7]+$/);
    expect(token.length).toBeGreaterThan(40);
    expect(token).not.toBe(generateDeviceTokenPlaintext());
  });

  it('derives a non-secret display id from the hash', () => {
    expect(displayIdFromHash('abcdef1234567890')).toBe('dtok_abcdef123456');
  });
});
