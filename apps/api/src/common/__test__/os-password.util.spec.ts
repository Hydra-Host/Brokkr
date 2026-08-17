import { describe, expect, it } from 'vitest';

import { hashOsPassword } from '../os-password.util';

describe('hashOsPassword', () => {
  it.each([
    [
      'brokkr',
      'abcd1234efgh5678',
      '$6$abcd1234efgh5678$LXf7pyWKf3ouzfS/KPbfg6oRSEUJj3WcqnpoDYszsUaPxfpebu3ZdNH5HVZeTGXXz9lEat1jhR70BGTlL9jwt0',
    ],
    [
      'hunter2',
      '0123456789abcdef',
      '$6$0123456789abcdef$GrCa1cuN5Plxg4bUmR0cJ9ohuWHAeWGcvZKD2crRyMGZbkg3t90kKEdI82BGc7AiTt5KY9TA0pFYP2h0miibi1',
    ],
  ])('matches `openssl passwd -6` for %s', (plaintext, salt, expected) => {
    expect(hashOsPassword(plaintext, salt)).toBe(expected);
  });

  it('produces a $6$ hash with a fresh random salt by default', () => {
    expect(hashOsPassword('s3cret')).toMatch(/^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]+$/);
  });

  it('uses a fresh random salt each call (same password → different hash)', () => {
    expect(hashOsPassword('same-password')).not.toBe(hashOsPassword('same-password'));
  });
});
