import { describe, expect, it } from 'vitest';
import { DEFAULT_PAYLOAD_BYTE_CAP, REDACTED, redactPayload } from '../redact-payload';

describe('redactPayload', () => {
  it('replaces secret-shaped keys at any depth', () => {
    const out = redactPayload({ a: 1, password: 'x', nested: { api_key: 'k', ok: 'v' } });
    expect(out).toEqual({ a: 1, password: REDACTED, nested: { api_key: REDACTED, ok: 'v' } });
  });

  it('walks arrays', () => {
    expect(redactPayload([{ token: 't' }, 2])).toEqual([{ token: REDACTED }, 2]);
  });

  it('returns a non-record value unchanged', () => {
    expect(redactPayload('plain')).toBe('plain');
  });

  it('returns null for null and undefined', () => {
    expect(redactPayload(null)).toBeNull();
    expect(redactPayload(undefined)).toBeNull();
  });

  it('replaces an oversized payload with its size', () => {
    const big = { blob: 'x'.repeat(DEFAULT_PAYLOAD_BYTE_CAP) };
    const out = redactPayload(big);
    expect(out).toMatchObject({ truncated: true });
    expect(redactPayload(big, { maxBytes: DEFAULT_PAYLOAD_BYTE_CAP + 100 })).toEqual(big);
  });
});
