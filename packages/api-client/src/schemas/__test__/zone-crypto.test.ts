import { EnrollmentParamsSchema, EnrollmentRequestSchema } from '../zone-crypto';

const VALID_HEX_64 = 'a'.repeat(64);
const VALID_UUID = '11111111-1111-4111-8111-111111111111';

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    registration_token: 'tok_abc123',
    zone_pub: VALID_HEX_64,
    mac: VALID_HEX_64,
    ...overrides,
  };
}

describe('EnrollmentRequestSchema', () => {
  it('accepts a well-formed enrollment request', () => {
    expect(EnrollmentRequestSchema.safeParse(baseRequest()).success).toBe(true);
  });

  describe('zone_pub / mac hex constraints', () => {
    const badHexCases: Array<[string, string]> = [
      ['uppercase hex', 'A'.repeat(64)],
      ['too short (63)', 'a'.repeat(63)],
      ['too long (65)', 'a'.repeat(65)],
      ['non-hex character', `${'a'.repeat(63)}g`],
      ['base64-looking', `${'a'.repeat(60)}+/==`],
      ['empty', ''],
    ];

    it.each(badHexCases)('rejects zone_pub: %s', (_label, value) => {
      expect(EnrollmentRequestSchema.safeParse(baseRequest({ zone_pub: value })).success).toBe(false);
    });

    it.each(badHexCases)('rejects mac: %s', (_label, value) => {
      expect(EnrollmentRequestSchema.safeParse(baseRequest({ mac: value })).success).toBe(false);
    });

    it('accepts lowercase hex with digits', () => {
      const mixed = '0123456789abcdef'.repeat(4);
      expect(EnrollmentRequestSchema.safeParse(baseRequest({ zone_pub: mixed, mac: mixed })).success).toBe(true);
    });
  });

  describe('registration_token bounds', () => {
    it('rejects an empty token', () => {
      expect(EnrollmentRequestSchema.safeParse(baseRequest({ registration_token: '' })).success).toBe(false);
    });

    it('accepts a token at the 256-char limit', () => {
      expect(EnrollmentRequestSchema.safeParse(baseRequest({ registration_token: 'x'.repeat(256) })).success).toBe(
        true,
      );
    });

    it('rejects a token over 256 chars', () => {
      expect(EnrollmentRequestSchema.safeParse(baseRequest({ registration_token: 'x'.repeat(257) })).success).toBe(
        false,
      );
    });
  });
});

describe('EnrollmentParamsSchema', () => {
  it('accepts a valid UUID zoneId', () => {
    expect(EnrollmentParamsSchema.safeParse({ zoneId: VALID_UUID }).success).toBe(true);
  });

  it.each([
    ['not a uuid', 'not-a-uuid'],
    ['empty', ''],
    ['numeric', '12345'],
  ])('rejects zoneId: %s', (_label, value) => {
    expect(EnrollmentParamsSchema.safeParse({ zoneId: value }).success).toBe(false);
  });
});
