import { describe, expect, it } from 'vitest';
import { CreateApiKeyRequestSchema } from '../api-keys';

const MAX_EXPIRY_MILLISECONDS = 10 * 365 * 24 * 60 * 60 * 1000;

describe('CreateApiKeyRequestSchema.expiresIn', () => {
  const base = { name: 'ci-key' };

  it('accepts a valid positive integer duration', () => {
    expect(CreateApiKeyRequestSchema.safeParse({ ...base, expiresIn: 86_400_000 }).success).toBe(true);
  });

  it('accepts an omitted expiresIn (non-expiring key)', () => {
    expect(CreateApiKeyRequestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts the exact maximum', () => {
    expect(CreateApiKeyRequestSchema.safeParse({ ...base, expiresIn: MAX_EXPIRY_MILLISECONDS }).success).toBe(true);
  });

  it.each([
    ['negative', -1],
    ['zero', 0],
    ['non-integer', 1.5],
    ['above the maximum', MAX_EXPIRY_MILLISECONDS + 1],
  ])('rejects %s', (_label, value) => {
    expect(CreateApiKeyRequestSchema.safeParse({ ...base, expiresIn: value }).success).toBe(false);
  });
});

describe('CreateApiKeyRequestSchema.name', () => {
  it('accepts 32 characters', () => {
    expect(CreateApiKeyRequestSchema.safeParse({ name: 'a'.repeat(32) }).success).toBe(true);
  });

  it('rejects 33 characters', () => {
    expect(CreateApiKeyRequestSchema.safeParse({ name: 'a'.repeat(33) }).success).toBe(false);
  });
});
